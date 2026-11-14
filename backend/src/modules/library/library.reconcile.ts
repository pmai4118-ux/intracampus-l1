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
      if (network.chainId !== 20261n) throw new LibraryChainError("WRONG_CHAIN");
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
      let logs;
      try {
        logs = await this.rpc.getLogs({ address: this.deployment.escrow.address, fromBlock, toBlock,
          topics: [this.verifier.lifecycleTopics()] });
      } catch { throw new LibraryChainError("RPC_UNAVAILABLE"); }
      if (logs.length > maxLogsPerRange) throw new LibraryChainError("RPC_UNAVAILABLE");
      const events = [];
      try {
        for (const log of logs) {
          const event = await this.verifier.verify(log, chain.safeBlock, chain.checkedAt);
          if (event) events.push(event);
        }
      } catch (error) {
        if (error instanceof LibraryChainError) throw error;
        if (error instanceof LibraryRpcError) throw new LibraryChainError(error.code);
        throw new LibraryChainError("RPC_UNAVAILABLE");
      }
      try {
        const result = this.repository.recordVerifiedChainEvents(events, toBlock, chain.checkedAt,
          JSON.stringify(this.deployment.policy));
        applied += result.applied;
        ignored += result.ignored;
      } catch (error) {
        if (error instanceof Error && error.message === "LIBRARY_REORG_DETECTED") throw new LibraryChainError("STALE_CHAIN_STATE");
        if (error instanceof Error && error.message === "LIBRARY_DATABASE_BUSY") throw error;
        throw new LibraryChainError("RPC_UNAVAILABLE");
      }
      cursor = toBlock;
      passes++;
    }
    const caughtUp = cursor >= chain.safeBlock;
    if (caughtUp) this.repository.expirePendingRequests(chain.chainTime);
    return { ...chain, caughtUp, applied, ignored };
  }

  private async checkCanonicality(chain: TrustedLibraryChain): Promise<void> {
    const cursor = this.repository.canonicalityCursor();
    let candidates = this.repository.eventCanonicalityCandidates(canonicalityBatch, cursor);
    if (candidates.length === 0 && cursor > 0) candidates = this.repository.eventCanonicalityCandidates(canonicalityBatch, 0);
    if (candidates.length === 0) return;
    const blockHashes = new Map<number, string>();
    for (const candidate of candidates) {
      if (candidate.blockNumber > chain.safeBlock) throw new LibraryChainError("STALE_CHAIN_STATE");
      if (!blockHashes.has(candidate.blockNumber)) {
        const block = await this.rpc.getBlock(candidate.blockNumber);
        if (!block?.hash) throw new LibraryChainError("RPC_UNAVAILABLE");
        blockHashes.set(candidate.blockNumber, block.hash.toLowerCase());
      }
      const observedHash = blockHashes.get(candidate.blockNumber)!;
      if (observedHash !== candidate.blockHash.toLowerCase()) {
        this.repository.markEventOrphaned({ eventId: candidate.eventId, observedBlockHash: observedHash, checkedAt: chain.checkedAt });
        throw new LibraryChainError("STALE_CHAIN_STATE");
      }
    }
    this.repository.advanceCanonicalityCursor(candidates[candidates.length - 1].eventId);
  }

  get verifierInstance(): LibraryReceiptVerifier { return this.verifier; }
}
