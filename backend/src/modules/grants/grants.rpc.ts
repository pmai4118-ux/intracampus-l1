import { getAddress, Interface, keccak256, toQuantity, type JsonRpcProvider } from "ethers";
import type { DeployedManifest } from "@intracampus/network";
import { GrantError, type GrantSnapshot, type VerifiedGrantEvent } from "./grants.types.ts";
export { GrantError } from "./grants.types.ts";
export type { GrantSnapshot, VerifiedGrantEvent } from "./grants.types.ts";

const FOOD = "0x2f6f5a261d6f4514c3f09a834720fe583c82f2ee4758ce9a45fbd67428e9f93d";
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS_WORD = /^0x0{24}[\da-f]{40}$/i;

export function grantAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[\da-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw new GrantError("INVALID_REQUEST");
  try { return getAddress(value).toLowerCase(); } catch { throw new GrantError("INVALID_REQUEST"); }
}
export function grantHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value) && !/^0x0{64}$/i.test(value); }
function record(value: unknown, code = "RPC_UNAVAILABLE"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GrantError(code);
  return value as Record<string, unknown>;
}
function quantity(value: unknown, code = "RPC_UNAVAILABLE"): number {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][\da-f]*)$/i.test(value)) throw new GrantError(code);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new GrantError(code);
  return n;
}
function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && /^0x[\da-f]{40}$/i.test(left) && left.toLowerCase() === right.toLowerCase();
}
function sameHash(left: unknown, right: string): boolean { return grantHash(left) && left.toLowerCase() === right.toLowerCase(); }
type PinnedBlock = { number: number; hash: string };

/** All RPC failures leave the boundary as stable codes; ethers errors can contain authenticated URLs. */
export class GrantsReader {
  readonly provider: JsonRpcProvider;
  readonly deployment: DeployedManifest;
  private readonly vault: Interface;
  private readonly registry: Interface;
  constructor(provider: JsonRpcProvider, deployment: DeployedManifest) {
    this.provider = provider; this.deployment = deployment;
    this.vault = new Interface(deployment.contracts.PurposeBoundGrantVault.abi);
    this.registry = new Interface(deployment.contracts.CampusPaymentRegistry.abi);
  }
  private async safe<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { throw error instanceof GrantError ? error : new GrantError("RPC_UNAVAILABLE"); }
  }
  private async chain(): Promise<void> {
    if (quantity(await this.provider.send("eth_chainId", [])) !== 20261) throw new GrantError("WRONG_CHAIN");
  }
  private async block(tag: number | "latest", code = "RPC_UNAVAILABLE"): Promise<PinnedBlock> {
    const result = record(await this.provider.send("eth_getBlockByNumber", [tag === "latest" ? tag : toQuantity(tag), false]), code);
    const number = quantity(result.number, code);
    if (!grantHash(result.hash) || (tag !== "latest" && number !== tag)) throw new GrantError(code);
    return { number, hash: result.hash };
  }
  private async call(abi: Interface, target: string, name: string, args: unknown[], block: number): Promise<unknown> {
    const data = await this.provider.send("eth_call", [{ to: target, data: abi.encodeFunctionData(name, args) }, toQuantity(block)]);
    if (typeof data !== "string" || !HASH.test(data)
      || (name === "allowedMerchantCategories" && !/^0x0{63}[01]$/i.test(data))) throw new GrantError("RPC_UNAVAILABLE");
    return abi.decodeFunctionResult(name, data)[0];
  }
  private async context(tag: number | "latest"): Promise<PinnedBlock> {
    await this.chain();
    const block = await this.block(tag);
    const { PurposeBoundGrantVault: vault, CampusPaymentRegistry: registry } = this.deployment.contracts;
    if (this.deployment.chainId !== 20261 || this.deployment.merchants.canteen.category.toLowerCase() !== FOOD) throw new GrantError("DEPLOYMENT_MISMATCH");
    grantAddress(this.deployment.merchants.canteen.address);
    for (const contract of [vault, registry]) {
      if (block.number < contract.blockNumber) throw new GrantError("DEPLOYMENT_MISMATCH");
      const deployed = await this.block(contract.blockNumber, "DEPLOYMENT_MISMATCH");
      if (!sameHash(deployed.hash, contract.blockHash)) throw new GrantError("DEPLOYMENT_MISMATCH");
      const code: unknown = await this.provider.send("eth_getCode", [contract.address, toQuantity(block.number)]);
      if (typeof code !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(code)
        || !sameHash(keccak256(code), contract.runtimeCodeHash)) throw new GrantError("DEPLOYMENT_MISMATCH");
    }
    const issuer = await this.call(this.vault, vault.address, "issuer", [], block.number);
    const linkedRegistry = await this.call(this.vault, vault.address, "merchantRegistry", [], block.number);
    if (!sameAddress(issuer, this.deployment.roles.grantIssuer) || !sameAddress(linkedRegistry, registry.address)) throw new GrantError("DEPLOYMENT_MISMATCH");
    return block;
  }
  private async unchanged(block: PinnedBlock, code = "CHAIN_CHANGED"): Promise<void> {
    await this.chain();
    if (!sameHash((await this.block(block.number, code)).hash, block.hash)) throw new GrantError(code);
  }
  private async allowed(merchant: string, block: number): Promise<boolean> {
    const result = await this.call(this.registry, this.deployment.contracts.CampusPaymentRegistry.address,
      "allowedMerchantCategories", [merchant, FOOD], block);
    if (typeof result !== "boolean") throw new GrantError("RPC_UNAVAILABLE");
    return result;
  }
  async snapshot(beneficiary: string, verifiedEvents: readonly VerifiedGrantEvent[] = []): Promise<GrantSnapshot> {
    return this.safe(async () => {
      beneficiary = grantAddress(beneficiary);
      const block = await this.context("latest");
      const balance = await this.call(this.vault, this.deployment.contracts.PurposeBoundGrantVault.address,
        "balances", [beneficiary, FOOD], block.number);
      if (typeof balance !== "bigint" || balance < 0n) throw new GrantError("RPC_UNAVAILABLE");
      const merchantAllowed = await this.allowed(this.deployment.merchants.canteen.address, block.number);
      for (const event of verifiedEvents) {
        if (event.blockNumber > block.number) throw new GrantError("CHAIN_CHANGED");
        await this.unchanged({ number: event.blockNumber, hash: event.blockHash });
      }
      await this.unchanged(block);
      return { blockNumber: block.number, blockHash: block.hash, balanceWei: balance, merchantAllowed };
    });
  }
  async verifyReceipt(hash: string, beneficiary: string): Promise<VerifiedGrantEvent[] | null> {
    return this.safe(async () => {
      beneficiary = grantAddress(beneficiary);
      if (!grantHash(hash)) throw new GrantError("INVALID_REQUEST");
      await this.chain();
      const result: unknown = await this.provider.send("eth_getTransactionReceipt", [hash]);
      if (result === null) return null;
      const receipt = record(result, "RECEIPT_MISMATCH");
      const status = quantity(receipt.status, "RECEIPT_MISMATCH");
      const vaultAddress = this.deployment.contracts.PurposeBoundGrantVault.address;
      if ((status !== 0 && status !== 1) || !sameHash(receipt.transactionHash, hash) || !sameAddress(receipt.to, vaultAddress)
        || !grantHash(receipt.blockHash) || !Array.isArray(receipt.logs)) throw new GrantError("RECEIPT_MISMATCH");
      const blockNumber = quantity(receipt.blockNumber, "RECEIPT_MISMATCH");
      const transactionIndex = quantity(receipt.transactionIndex, "RECEIPT_MISMATCH");
      const block = await this.context(blockNumber);
      if (!sameHash(block.hash, receipt.blockHash)) throw new GrantError("RECEIPT_MISMATCH");
      if (status === 0) {
        if (receipt.logs.length !== 0) throw new GrantError("RECEIPT_MISMATCH");
        await this.unchanged(block, "RECEIPT_MISMATCH");
        throw new GrantError("TX_REVERTED");
      }
      const events: VerifiedGrantEvent[] = [];
      const indices = new Set<number>();
      for (const raw of receipt.logs) {
        const log = record(raw, "RECEIPT_MISMATCH");
        if (!sameAddress(log.address, vaultAddress)) continue;
        if (!sameHash(log.transactionHash, hash) || !sameHash(log.blockHash, block.hash)
          || quantity(log.blockNumber, "RECEIPT_MISMATCH") !== block.number
          || quantity(log.transactionIndex, "RECEIPT_MISMATCH") !== transactionIndex || log.removed === true
          || typeof log.data !== "string" || !/^0x(?:[\da-f]{2})*$/i.test(log.data)
          || !Array.isArray(log.topics) || !log.topics.every((topic): topic is string => typeof topic === "string" && HASH.test(topic))) throw new GrantError("RECEIPT_MISMATCH");
        const logIndex = quantity(log.logIndex, "RECEIPT_MISMATCH");
        if (indices.has(logIndex)) throw new GrantError("RECEIPT_MISMATCH");
        indices.add(logIndex);
        const signature = log.topics[0]?.toLowerCase();
        const issued = signature === this.vault.getEvent("GrantIssued")?.topicHash.toLowerCase();
        const spent = signature === this.vault.getEvent("GrantSpent")?.topicHash.toLowerCase();
        if (!issued && !spent) continue;
        if (log.topics.length !== 4 || !/^0x[\da-f]{128}$/i.test(log.data)
          || !ADDRESS_WORD.test(log.topics[1]) || !ADDRESS_WORD.test(log.topics[issued ? 3 : 2])) throw new GrantError("RECEIPT_MISMATCH");
        let parsed;
        try { parsed = this.vault.parseLog({ topics: log.topics, data: log.data }); }
        catch { throw new GrantError("RECEIPT_MISMATCH"); }
        if (!parsed || (parsed.name !== "GrantIssued" && parsed.name !== "GrantSpent")) continue;
        const { args } = parsed;
        if (!sameAddress(args.beneficiary, beneficiary) || !sameHash(args.category, FOOD)
          || typeof args.amount !== "bigint" || args.amount <= 0n || typeof args.balance !== "bigint" || args.balance < 0n) throw new GrantError("RECEIPT_MISMATCH");
        const event: VerifiedGrantEvent = { event: parsed.name, transactionHash: hash, blockNumber, blockHash: block.hash,
          logIndex, beneficiary, category: FOOD, amountWei: args.amount.toString(), balanceWei: args.balance.toString() };
        if (parsed.name === "GrantIssued") {
          if (!sameAddress(args.issuer, this.deployment.roles.grantIssuer)) throw new GrantError("RECEIPT_MISMATCH");
          event.issuer = getAddress(args.issuer).toLowerCase();
        } else {
          // A successful event from the pinned, verified vault proves its execution-time allowlist
          // check. Reading the block's final allowlist would reject a valid spend if a later
          // transaction in that block revoked the merchant. Current permission belongs in snapshot.
          if (typeof args.merchant !== "string" || sameAddress(args.merchant, beneficiary)
            || /^0x0{40}$/i.test(args.merchant) || sameAddress(args.merchant, vaultAddress)) throw new GrantError("RECEIPT_MISMATCH");
          event.merchant = getAddress(args.merchant).toLowerCase();
        }
        events.push(event);
      }
      if (events.length === 0) throw new GrantError("RECEIPT_MISMATCH");
      await this.unchanged(block, "RECEIPT_MISMATCH");
      return events.sort((a, b) => a.logIndex - b.logIndex);
    });
  }
  async issued(beneficiary: string, toBlock: number): Promise<VerifiedGrantEvent[]> {
    return this.safe(async () => {
      beneficiary = grantAddress(beneficiary);
      if (!Number.isSafeInteger(toBlock) || toBlock < this.deployment.contracts.PurposeBoundGrantVault.blockNumber) throw new GrantError("INVALID_REQUEST");
      const pinned = await this.context(toBlock);
      const fragment = this.vault.getEvent("GrantIssued");
      if (!fragment) throw new GrantError("DEPLOYMENT_MISMATCH");
      const topics = this.vault.encodeFilterTopics(fragment, [beneficiary, FOOD]);
      const verified = new Map<string, VerifiedGrantEvent>();
      const receipts = new Map<string, VerifiedGrantEvent[]>();
      for (let from = this.deployment.contracts.PurposeBoundGrantVault.blockNumber; from <= toBlock; from += 1000) {
        const end = Math.min(from + 999, toBlock);
        const logs: unknown = await this.provider.send("eth_getLogs", [{ address: this.deployment.contracts.PurposeBoundGrantVault.address,
          fromBlock: toQuantity(from), toBlock: toQuantity(end), topics }]);
        if (!Array.isArray(logs)) throw new GrantError("RPC_UNAVAILABLE");
        for (const raw of logs) {
          const log = record(raw, "RECEIPT_MISMATCH");
          const blockNumber = quantity(log.blockNumber, "RECEIPT_MISMATCH");
          const index = quantity(log.logIndex, "RECEIPT_MISMATCH");
          if (!grantHash(log.transactionHash) || blockNumber < from || blockNumber > end || log.removed === true
            || !sameAddress(log.address, this.deployment.contracts.PurposeBoundGrantVault.address)) throw new GrantError("RECEIPT_MISMATCH");
          const hash = log.transactionHash.toLowerCase();
          let events = receipts.get(hash);
          if (!events) {
            events = await this.verifyReceipt(hash, beneficiary) ?? undefined;
            if (!events) throw new GrantError("RECEIPT_MISMATCH");
            receipts.set(hash, events);
          }
          const event = events.find((entry) => entry.event === "GrantIssued" && entry.logIndex === index
            && entry.blockNumber === blockNumber && sameHash(log.blockHash, entry.blockHash));
          if (!event) throw new GrantError("RECEIPT_MISMATCH");
          verified.set(`${hash}:${index}`, event);
        }
      }
      if (verified.size === 0) {
        // An empty index is not evidence of absence: the grant may already be fully spent.
        // Establish absence from the canonical blocks' transaction receipts before allowing seed.
        for (let number = this.deployment.contracts.PurposeBoundGrantVault.blockNumber; number <= toBlock; number++) {
          const rawBlock = record(await this.provider.send("eth_getBlockByNumber", [toQuantity(number), false]));
          if (quantity(rawBlock.number) !== number || !grantHash(rawBlock.hash) || !Array.isArray(rawBlock.transactions)
            || !rawBlock.transactions.every(grantHash) || new Set(rawBlock.transactions).size !== rawBlock.transactions.length) throw new GrantError("RPC_UNAVAILABLE");
          for (const [index, hash] of rawBlock.transactions.entries()) {
            const receipt = record(await this.provider.send("eth_getTransactionReceipt", [hash]));
            if (!sameHash(receipt.transactionHash, hash) || !sameHash(receipt.blockHash, rawBlock.hash)
              || quantity(receipt.blockNumber) !== number || quantity(receipt.transactionIndex) !== index
              || !Array.isArray(receipt.logs) || ![0, 1].includes(quantity(receipt.status))) throw new GrantError("RPC_UNAVAILABLE");
            for (const raw of receipt.logs) {
              const log = record(raw);
              if (!sameAddress(log.address, this.deployment.contracts.PurposeBoundGrantVault.address)
                || !Array.isArray(log.topics) || log.topics[0] !== fragment.topicHash) continue;
              // Verify only this beneficiary/category; unrelated public receipts may contain other grants.
              if (typeof log.topics[1] !== "string" || !ADDRESS_WORD.test(log.topics[1])
                || !sameAddress(`0x${log.topics[1].slice(-40)}`, beneficiary) || !sameHash(log.topics[2], FOOD)) continue;
              const events = await this.verifyReceipt(hash, beneficiary);
              if (!events) throw new GrantError("RPC_UNAVAILABLE");
              for (const event of events.filter((event) => event.event === "GrantIssued")) verified.set(`${hash}:${event.logIndex}`, event);
            }
          }
          await this.unchanged({ number, hash: rawBlock.hash });
        }
      }
      await this.unchanged(pinned);
      return [...verified.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    });
  }
}
