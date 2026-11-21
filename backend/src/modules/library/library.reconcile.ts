import { CAMPUS_CHAIN_ID } from "@intracampus/network";
import { keccak256 } from "ethers";
import type { DeployedLibraryDeployment } from "@intracampus/network";
import type { LibraryChainFreshness } from "./library.config.ts";
import type { LibraryRepository } from "./library.repository.ts";
import { LibraryRpcError, type LibraryRpcClient } from "./library.rpc.ts";
import { LibraryReceiptVerifier } from "./library.verifier.ts";

export class LibraryChainError extends Error {
  readonly code: "RPC_UNAVAILABLE" | "WRONG_CHAIN" | "STALE_CHAIN_STATE" | "CONFIGURATION_ERROR";
  constructor(code: LibraryChainError["code"]) { super(code); this.code = code; }
}

export type TrustedLibraryChain = { chainTime: number; latestBlock: number; safeBlock: number; checkedAt: number };

const logRange = 1000;
const rangesPerPass = 10;
const maxLogsPerRange = 2000;
const canonicalityBatch = 200;
const eventVerificationConcurrency = 16;

function tooManyLogs(error: unknown): boolean {
  const value = error && typeof error === "object" ? error as {
    code?: unknown; message?: unknown; response?: unknown; info?: unknown;
  } : {};
  const info = value.info && typeof value.info === "object" ? value.info as { responseStatus?: unknown } : {};
  const response = value.response && typeof value.response === "object"
    ? value.response as { statusCode?: unknown; status?: unknown } : {};
  const responseStatus = typeof info.responseStatus === "string" ? /^\s*(\d{3})(?:\s|$)/.exec(info.responseStatus) : null;
  const httpStatus = typeof response.statusCode === "number" ? response.statusCode
    : typeof response.status === "number" ? response.status
      : responseStatus ? Number(responseStatus[1]) : null;
  const message = typeof value.message === "string" ? value.message : "";
  if (httpStatus === 429 || /rate[- ]limit|too many requests|throttl(?:ed|ing)?/i.test(message)) return false;
  return value.code === -32005 || value.code === "-32005"
    || /too many (?:logs|results)|more than \d+ results|response size exceeded/i.test(message);
}

export class LibraryReconciler {
  private readonly repository: LibraryRepository;
  private readonly rpc: LibraryRpcClient;
  private readonly deployment: DeployedLibraryDeployment;
  private readonly freshness: LibraryChainFreshness;
  private readonly verifier: LibraryReceiptVerifier;
  private readonly now: () => number;

  constructor(repository: LibraryRepository, rpc: LibraryRpcClient, deployment: DeployedLibraryDeployment,
    freshness: LibraryChainFreshness, now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.repository = repository;
    this.rpc = rpc;
    this.deployment = deployment;
    this.freshness = freshness;
    this.verifier = new LibraryReceiptVerifier(rpc, deployment);
    this.now = now;
  }

  async trustedChain(): Promise<TrustedLibraryChain> {
    try {
      const network = await this.rpc.getNetwork();
      if (network.chainId !== BigInt(CAMPUS_CHAIN_ID)) throw new LibraryChainError("WRONG_CHAIN");
      const latest = await this.rpc.getBlock("latest");
      if (!latest || !Number.isSafeInteger(latest.number) || latest.number < 0) throw new LibraryChainError("RPC_UNAVAILABLE");
      const safeNumber = latest.number - (this.freshness.minConfirmations - 1);
      if (safeNumber < this.deployment.escrow.blockNumber) throw new LibraryChainError("STALE_CHAIN_STATE");
      const safe = await this.rpc.getBlock(safeNumber);
      if (!safe || safe.number !== safeNumber || !Number.isSafeInteger(safe.timestamp)) throw new LibraryChainError("RPC_UNAVAILABLE");
      const checkedAt = this.now();
      if (!Number.isSafeInteger(checkedAt) || checkedAt < 0 || checkedAt >= 8_640_000_000_000
        || safe.timestamp < checkedAt - this.freshness.maxStaleSeconds
        || safe.timestamp > checkedAt + this.freshness.maxFutureDriftSeconds) throw new LibraryChainError("STALE_CHAIN_STATE");
      const deploymentBlock = await this.rpc.getBlock(this.deployment.verifiedAt.blockNumber);
      if (!deploymentBlock?.hash || deploymentBlock.hash.toLowerCase() !== this.deployment.verifiedAt.blockHash.toLowerCase()) {
        throw new LibraryChainError("CONFIGURATION_ERROR");
      }
      const code = await this.rpc.getCode(this.deployment.escrow.address, safeNumber);
      if (code === "0x" || keccak256(code).toLowerCase() !== this.deployment.escrow.runtimeCodeHash.toLowerCase()) {
        throw new LibraryChainError("CONFIGURATION_ERROR");
      }
      return { chainTime: safe.timestamp, latestBlock: latest.number, safeBlock: safeNumber, checkedAt };
    } catch (error) {
      if (error instanceof LibraryChainError) throw error;
      if (error instanceof LibraryRpcError) throw new LibraryChainError(error.code);
      throw new LibraryChainError("RPC_UNAVAILABLE");
    }
  }

  async reconcile(): Promise<TrustedLibraryChain & { caughtUp: boolean; applied: number; ignored: number }> {
    const chain = await this.trustedChain();
    const state = this.repository.reconcileState();
    if (state.health !== "HEALTHY") throw new LibraryChainError("STALE_CHAIN_STATE");
    await this.checkCanonicality(chain);
    this.repository.initializeReconcileCursor(this.deployment.escrow.blockNumber, chain.checkedAt);
    let cursor = this.repository.reconcileState().cursorBlock;
    let applied = 0, ignored = 0, passes = 0;
    while (cursor < chain.safeBlock && passes < rangesPerPass) {
      const fromBlock = cursor + 1;
      const toBlock = Math.min(chain.safeBlock, fromBlock + logRange - 1);
      const result = await this.reconcileLogRange(fromBlock, toBlock, chain);
      applied += result.applied;
      ignored += result.ignored;
      cursor = toBlock;
      passes++;
    }
    const caughtUp = cursor >= chain.safeBlock;
    await this.reconcilePendingTransactions(chain);
    if (caughtUp) this.repository.expirePendingRequests(chain.chainTime);
    return { ...chain, caughtUp, applied, ignored };
  }

  private async reconcilePendingTransactions(chain: TrustedLibraryChain): Promise<void> {
    const pending = this.repository.pendingTransactions(100);
    if (pending.length === 0) return;
    let receipts;
    try {
      receipts = await Promise.all(pending.map(async (transaction) => ({ transaction,
        receipt: await this.rpc.getTransactionReceipt(transaction.txHash) })));
    } catch (error) {
      if (error instanceof LibraryRpcError) throw new LibraryChainError(error.code);
      throw new LibraryChainError("RPC_UNAVAILABLE");
    }
    const reverted = receipts.filter(({ receipt, transaction }) => receipt?.status === 0
      && receipt.hash?.toLowerCase() === transaction.txHash.toLowerCase() && Number.isSafeInteger(receipt.blockNumber)
      && receipt.blockNumber <= chain.safeBlock && typeof receipt.blockHash === "string");
    let blocks;
    try {
      blocks = await Promise.all(reverted.map(({ receipt }) => this.rpc.getBlock(receipt!.blockNumber)));
    } catch (error) {
      if (error instanceof LibraryRpcError) throw new LibraryChainError(error.code);
      throw new LibraryChainError("RPC_UNAVAILABLE");
    }
    for (const [index, entry] of reverted.entries()) {
      const block = blocks[index];
      if (!block?.hash || block.number !== entry.receipt!.blockNumber || block.hash.toLowerCase() !== entry.receipt!.blockHash.toLowerCase()) continue;
      try {
        this.repository.markTransactionReverted({ requestId: entry.transaction.requestId, action: entry.transaction.action,
          txHash: entry.transaction.txHash, blockNumber: entry.receipt!.blockNumber, blockHash: block.hash, checkedAt: chain.checkedAt });
      } catch (error) {
        if (error instanceof Error && error.message === "LIBRARY_DATABASE_BUSY") throw error;
        throw new LibraryChainError("RPC_UNAVAILABLE");
      }
    }
  }

  private async checkCanonicality(chain: TrustedLibraryChain): Promise<void> {
    const cursor = this.repository.canonicalityCursor();
    let candidates = this.repository.eventCanonicalityCandidates(canonicalityBatch, cursor);
    if (candidates.length === 0 && cursor > 0) candidates = this.repository.eventCanonicalityCandidates(canonicalityBatch, 0);
    if (candidates.length === 0) return;
    const blockNumbers = [...new Set(candidates.map((candidate) => candidate.blockNumber))];
    if (blockNumbers.some((blockNumber) => blockNumber > chain.safeBlock)) throw new LibraryChainError("STALE_CHAIN_STATE");
    const blockHashes = new Map<number, string>();
    try {
      const blocks = await Promise.all(blockNumbers.map((blockNumber) => this.rpc.getBlock(blockNumber)));
      for (const [index, block] of blocks.entries()) {
        if (!block?.hash) throw new LibraryChainError("RPC_UNAVAILABLE");
        blockHashes.set(blockNumbers[index], block.hash.toLowerCase());
      }
    } catch (error) {
      if (error instanceof LibraryChainError) throw error;
      if (error instanceof LibraryRpcError) throw new LibraryChainError(error.code);
      throw new LibraryChainError("RPC_UNAVAILABLE");
    }
    for (const candidate of candidates) {
      const observedHash = blockHashes.get(candidate.blockNumber)!;
      if (observedHash !== candidate.blockHash.toLowerCase()) {
        this.repository.markEventOrphaned({ eventId: candidate.eventId, observedBlockHash: observedHash, checkedAt: chain.checkedAt });
        throw new LibraryChainError("STALE_CHAIN_STATE");
      }
    }
    this.repository.advanceCanonicalityCursor(candidates[candidates.length - 1].eventId);
  }

  private async reconcileLogRange(fromBlock: number, toBlock: number, chain: TrustedLibraryChain): Promise<{ applied: number; ignored: number }> {
    let logs;
    try {
      logs = await this.rpc.getLogs({ address: this.deployment.escrow.address, fromBlock, toBlock,
        topics: [this.verifier.lifecycleTopics()] });
    } catch (error) {
      if (!tooManyLogs(error) || fromBlock === toBlock) {
        if (error instanceof LibraryRpcError) throw new LibraryChainError(error.code);
        throw new LibraryChainError("RPC_UNAVAILABLE");
      }
      const midpoint = Math.floor((fromBlock + toBlock) / 2);
      const left = await this.reconcileLogRange(fromBlock, midpoint, chain);
      const right = await this.reconcileLogRange(midpoint + 1, toBlock, chain);
      return { applied: left.applied + right.applied, ignored: left.ignored + right.ignored };
    }
    if (logs.length > maxLogsPerRange) {
      if (fromBlock === toBlock) throw new LibraryChainError("RPC_UNAVAILABLE");
      const midpoint = Math.floor((fromBlock + toBlock) / 2);
      const left = await this.reconcileLogRange(fromBlock, midpoint, chain);
      const right = await this.reconcileLogRange(midpoint + 1, toBlock, chain);
      return { applied: left.applied + right.applied, ignored: left.ignored + right.ignored };
    }
    logs.sort((left, right) => left.blockNumber - right.blockNumber || left.index - right.index);
    const events = [];
    try {
      for (let offset = 0; offset < logs.length; offset += eventVerificationConcurrency) {
        const verified = await Promise.all(logs.slice(offset, offset + eventVerificationConcurrency)
          .map((log) => this.verifier.verify(log, chain.safeBlock, chain.checkedAt)));
        events.push(...verified.filter((event) => event !== null));
      }
    } catch (error) {
      if (error instanceof LibraryChainError) throw error;
      if (error instanceof LibraryRpcError) throw new LibraryChainError(error.code);
      throw new LibraryChainError("RPC_UNAVAILABLE");
    }
    try {
      return this.repository.recordVerifiedChainEvents(events, toBlock, chain.checkedAt,
        JSON.stringify(this.deployment.policy));
    } catch (error) {
      if (error instanceof Error && error.message === "LIBRARY_REORG_DETECTED") throw new LibraryChainError("STALE_CHAIN_STATE");
      if (error instanceof Error && error.message === "LIBRARY_DATABASE_BUSY") throw error;
      throw new LibraryChainError("RPC_UNAVAILABLE");
    }
  }

  get verifierInstance(): LibraryReceiptVerifier { return this.verifier; }
}
