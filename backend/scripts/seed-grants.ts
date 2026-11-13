import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FetchRequest, Interface, JsonRpcProvider, Transaction, Wallet, getAddress, id, keccak256 } from "ethers";
import { campusNetwork, requireDeployment } from "@intracampus/network";
import { parseSeedConfig } from "./seed-demo.ts";
import type { SeedConfig } from "./seed-demo.ts";
import type { DeployedManifest } from "@intracampus/network";
import type { GrantSnapshot, VerifiedGrantEvent } from "../src/modules/grants/grants.types.ts";
import { GrantSeedJournal } from "../src/modules/grants/grants.seed-repository.ts";
import { GrantError, GrantsReader } from "../src/modules/grants/grants.rpc.ts";

export type GrantSeedReader = {
  deployment: DeployedManifest;
  snapshot(beneficiary: string, verifiedEvents?: readonly VerifiedGrantEvent[]): Promise<GrantSnapshot>;
  issued(beneficiary: string, toBlock: number, expectedBlockHash?: string): Promise<VerifiedGrantEvent[]>;
  verifyReceipt(hash: string, beneficiary: string): Promise<VerifiedGrantEvent[] | null>;
};
export type GrantSeedTransport = {
  address: string;
  prepare(beneficiary: string, category: string, amountWei: bigint): Promise<{ hash: string; nonce: number; rawTransaction: string }>;
  broadcast(rawTransaction: string): Promise<string>;
};
export type GrantSeedOptions = {
  config: SeedConfig; reader: GrantSeedReader; journal?: GrantSeedJournal;
  transport?: GrantSeedTransport; apply?: boolean;
  emit?: (event: { event: "grant-seed-intent"; transactionHash: string }) => void;
};
export class GrantSeedError extends Error {
  constructor(code: string) { super(code); this.name = "GrantSeedError"; }
}
/** Only the transport's local pre-send phase may declare that nothing was broadcast. */
export class GrantNotBroadcastError extends GrantSeedError {}
export type GrantSeedResult = {
  mode: "dry-run" | "apply"; status: "planned" | "already-issued" | "confirmed";
  beneficiary: string; amountWei: string; balanceWei: string; transactionHash?: string;
  recovery?: "canonical-revert";
};
const AMOUNT = 5000000000000000000000n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function seedGrant({ config, reader, journal, transport, apply = false, emit = () => {} }: GrantSeedOptions): Promise<GrantSeedResult> {
  const deployment = reader.deployment;
  const vault = deployment.contracts.PurposeBoundGrantVault;
  const beneficiary = getAddress(config.student.address);
  const category = deployment.merchants.canteen.category;
  if (config.chainId !== 20261 || deployment.chainId !== 20261 || !same(category, id("FOOD"))) throw new GrantSeedError("INVALID_SEED_CONFIG");
  const forbidden = [...Object.values(deployment.contracts).map((c) => c.address), ...Object.values(deployment.roles),
    ...Object.values(deployment.merchants).map((m) => m.address), config.funder, config.normal.address, "0x0000000000000000000000000000000000000000"];
  if (forbidden.some((address) => same(address, beneficiary))) throw new GrantSeedError("INVALID_BENEFICIARY");
  const operationId = id(JSON.stringify(["b05-food-v1", deployment.chainId, vault.address.toLowerCase(), vault.blockHash.toLowerCase(),
    deployment.roles.grantIssuer.toLowerCase(), beneficiary.toLowerCase(), category.toLowerCase(), AMOUNT.toString()]));
  const snapshot = await reader.snapshot(beneficiary);
  const base = { mode: apply ? "apply" as const : "dry-run" as const, beneficiary,
    amountWei: AMOUNT.toString(), balanceWei: snapshot.balanceWei.toString() };
  function validate(events: VerifiedGrantEvent[], expectedHash?: string): VerifiedGrantEvent {
    const event = events[0];
    if (events.length !== 1 || event.event !== "GrantIssued" || !same(event.beneficiary, beneficiary)
      || !same(event.category, category) || !event.issuer || !same(event.issuer, deployment.roles.grantIssuer)
      || event.amountWei !== AMOUNT.toString() || (expectedHash && !same(event.transactionHash, expectedHash))) {
      throw new GrantSeedError("SEED_RECEIPT_MISMATCH");
    }
    return event;
  }
  const prior = journal?.get(operationId);
  async function receiptFor(hash: string): Promise<VerifiedGrantEvent[] | null> {
    try { return await reader.verifyReceipt(hash, beneficiary); }
    catch (error) {
      // Only the reader's strict canonical status-0 verdict is terminal proof. Generic RPC
      // errors, missing/orphaned receipts and mismatched logs must retain the active intent.
      if (!(error instanceof GrantError) || error.code !== "TX_REVERTED") throw error;
      journal!.retire(operationId, hash, "canonical-revert");
      throw new GrantSeedError("SEED_REVERTED_RETRY_ALLOWED");
    }
  }
  if (prior) {
    // Dry-run is read-only, including when the intent is known to have reverted.
    let receipt: VerifiedGrantEvent[] | null;
    if (!apply) {
      try { receipt = await reader.verifyReceipt(prior.transactionHash, beneficiary); }
      catch (error) {
        if (!(error instanceof GrantError) || error.code !== "TX_REVERTED") throw error;
        return { ...base, status: "planned", recovery: "canonical-revert", transactionHash: prior.transactionHash };
      }
    } else receipt = await receiptFor(prior.transactionHash);
    if (!receipt) throw new GrantSeedError("SEED_OUTCOME_UNKNOWN");
    validate(receipt, prior.transactionHash);
    const current = await reader.snapshot(beneficiary, receipt);
    return { ...base, status: "already-issued", transactionHash: prior.transactionHash, balanceWei: current.balanceWei.toString() };
  }
  const history = await reader.issued(beneficiary, snapshot.blockNumber, snapshot.blockHash);
  if (history.length) {
    if (history.length !== 1 || history[0].amountWei !== AMOUNT.toString()) throw new GrantSeedError("EXISTING_GRANT_CONFLICT");
    const event = validate(history);
    const current = await reader.snapshot(beneficiary, history);
    return { ...base, status: "already-issued", transactionHash: event.transactionHash, balanceWei: current.balanceWei.toString() };
  }
  if (snapshot.balanceWei !== 0n) throw new GrantSeedError("GRANT_HISTORY_INCONSISTENT");
  if (!snapshot.merchantAllowed) throw new GrantSeedError("MERCHANT_NOT_ALLOWED");
  if (!apply) return { ...base, status: "planned" };
  if (!journal) throw new GrantSeedError("SEED_JOURNAL_REQUIRED");
  if (!transport) throw new GrantSeedError("SIGNING_KEY_NOT_CONFIGURED");
  if (!same(transport.address, deployment.roles.grantIssuer)) throw new GrantSeedError("ISSUER_KEY_MISMATCH");
  const prepared = await transport.prepare(beneficiary, category, AMOUNT);
  try {
    const tx = Transaction.from(prepared.rawTransaction);
    const expectedData = new Interface(vault.abi).encodeFunctionData("grant", [beneficiary, category]);
    if (!tx.isSigned() || tx.hash !== prepared.hash || tx.nonce !== prepared.nonce || tx.chainId !== 20261n
      || !tx.to || !same(tx.to, vault.address) || !tx.from || !same(tx.from, deployment.roles.grantIssuer)
      || tx.value !== AMOUNT || tx.data !== expectedData) throw new Error();
  } catch { throw new GrantSeedError("INVALID_SIGNED_GRANT"); }
  // Recheck before persisting/broadcasting. The unique durable row serializes concurrent runs.
  const beforeSend = await reader.snapshot(beneficiary);
  if (!beforeSend.merchantAllowed) throw new GrantSeedError("MERCHANT_NOT_ALLOWED");
  const samePinnedBlock = beforeSend.blockNumber === snapshot.blockNumber && same(beforeSend.blockHash, snapshot.blockHash);
  const preSendHistory = samePinnedBlock ? history : await reader.issued(beneficiary, beforeSend.blockNumber, beforeSend.blockHash);
  if (beforeSend.balanceWei !== 0n || preSendHistory.length) {
    throw new GrantSeedError("GRANT_CHANGED_DURING_SEED");
  }
  if (!journal.reserve(operationId, { transactionHash: prepared.hash, nonce: prepared.nonce })) throw new GrantSeedError("SEED_OUTCOME_UNKNOWN");
  emit({ event: "grant-seed-intent", transactionHash: prepared.hash });
  try { await transport.broadcast(prepared.rawTransaction); } catch (error) {
    if (error instanceof GrantNotBroadcastError) {
      journal.retire(operationId, prepared.hash, "not-broadcast");
      throw error;
    }
    // RPC rejection/timeout can follow acceptance. The stored hash is the only recovery path.
  }
  const receipt = await receiptFor(prepared.hash);
  if (!receipt) throw new GrantSeedError("SEED_OUTCOME_UNKNOWN");
  validate(receipt, prepared.hash);
  const after = await reader.snapshot(beneficiary, receipt);
  return { ...base, status: "confirmed", transactionHash: prepared.hash, balanceWei: after.balanceWei.toString() };
}

/** Signing stays on the issuer machine; raw transactions exist only in memory. */
export function createGrantSeedTransport(provider: JsonRpcProvider, wallet: Wallet, deployment: DeployedManifest): GrantSeedTransport {
  const abi = new Interface(deployment.contracts.PurposeBoundGrantVault.abi);
  async function chain(): Promise<void> {
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(campusNetwork.chainId)) throw new GrantSeedError("WRONG_CHAIN");
  }
  async function nonce(): Promise<number> {
    const latest = BigInt(await provider.send("eth_getTransactionCount", [wallet.address, "latest"]));
    const pending = BigInt(await provider.send("eth_getTransactionCount", [wallet.address, "pending"]));
    if (pending !== latest) throw new GrantSeedError("ISSUER_HAS_PENDING_TRANSACTIONS");
    if (latest < 0n || latest > BigInt(Number.MAX_SAFE_INTEGER)) throw new GrantSeedError("INVALID_NONCE");
    return Number(latest);
  }
  return {
    address: wallet.address,
    prepare: async (beneficiary, category, amountWei) => {
      await chain();
      if (!same(wallet.address, deployment.roles.grantIssuer)) throw new GrantSeedError("ISSUER_KEY_MISMATCH");
      const next = await nonce();
      const transaction = await wallet.populateTransaction({ to: deployment.contracts.PurposeBoundGrantVault.address,
        chainId: campusNetwork.chainId, nonce: next, value: amountWei,
        data: abi.encodeFunctionData("grant", [beneficiary, category]) });
      const rawTransaction = await wallet.signTransaction(transaction);
      return { rawTransaction, hash: keccak256(rawTransaction), nonce: next };
    },
    broadcast: async (rawTransaction) => {
      let tx: Transaction;
      try {
        await chain();
        tx = Transaction.from(rawTransaction);
        if (await nonce() !== tx.nonce) throw new GrantSeedError("ISSUER_NONCE_CHANGED");
      } catch (error) {
        throw new GrantNotBroadcastError(error instanceof GrantSeedError ? error.message : "RPC_UNAVAILABLE");
      }
      const sent = await provider.broadcastTransaction(rawTransaction);
      if (sent.hash !== tx.hash) throw new GrantSeedError("BROADCAST_HASH_MISMATCH");
      // A timeout leaves the durable intent in place; rerun reconciles its receipt only.
      await provider.waitForTransaction(sent.hash, 1, 30000);
      return sent.hash;
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    accounts: { type: "string" }, deployment: { type: "string" }, journal: { type: "string" },
    apply: { type: "boolean", default: false }, "allow-local": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("seed-grants --accounts <B03-public.json> [--deployment <L06.json>] [--journal <persistent.sqlite>] [--apply] [--allow-local]\nDefault: read-only dry-run. Exactly one 5000 CAMPUS FOOD allocation per deployment/student. See docs/b05-grants.md.");
    return;
  }
  if (!values.accounts) throw new GrantSeedError("USAGE_SEE_HELP");
  const config = parseSeedConfig(JSON.parse(await readFile(resolve(values.accounts), "utf8")));
  let deployment: DeployedManifest;
  try {
    deployment = requireDeployment(values.deployment ? JSON.parse(await readFile(resolve(values.deployment), "utf8")) : undefined,
      { allowLocal: values["allow-local"] });
  } catch (error) {
    throw new GrantSeedError(error instanceof Error && error.message === "DEPLOYMENT_NOT_CONFIGURED" ? error.message : "INVALID_DEPLOYMENT");
  }
  const rpcUrl = process.env.INTRACAMPUS_RPC_URL;
  try {
    const url = new URL(rpcUrl ?? "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    if (deployment.environment === "local-anvil" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error();
  } catch { throw new GrantSeedError("RPC_NOT_CONFIGURED"); }
  const request = new FetchRequest(rpcUrl!); request.timeout = 5000;
  const provider = new JsonRpcProvider(request, campusNetwork.chainId, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  const journalPath = resolve(values.journal ?? fileURLToPath(new URL("../data/grant-seed.sqlite", import.meta.url)));
  let journal: GrantSeedJournal | undefined;
  try {
    const reader = new GrantsReader(provider, deployment);
    // A dry-run may inspect an existing journal but never creates an intent or needs a signer.
    if (existsSync(journalPath)) journal = new GrantSeedJournal(journalPath, { readOnly: true });
    const plan = await seedGrant({ config, reader, journal });
    console.log(JSON.stringify({ event: "grant-seed-plan", chainId: campusNetwork.chainId, environment: deployment.environment,
      vaultAddress: deployment.contracts.PurposeBoundGrantVault.address, registryAddress: deployment.contracts.CampusPaymentRegistry.address,
      issuer: deployment.roles.grantIssuer, category: deployment.merchants.canteen.category, merchant: deployment.merchants.canteen.address, ...plan }));
    if (!values.apply) return;
    journal?.close(); journal = undefined;
    if (plan.status === "already-issued") {
      console.log(JSON.stringify({ event: "grant-seed-result", ...plan, mode: "apply" }));
      return;
    }
    const key = process.env.SEED_GRANT_ISSUER_PRIVATE_KEY;
    if (!key || !/^0x[\da-f]{64}$/i.test(key)) throw new GrantSeedError("SIGNING_KEY_NOT_CONFIGURED");
    const wallet = new Wallet(key, provider);
    if (!same(wallet.address, deployment.roles.grantIssuer)) throw new GrantSeedError("ISSUER_KEY_MISMATCH");
    journal = new GrantSeedJournal(journalPath);
    const result = await seedGrant({ config, reader, journal, apply: true, transport: createGrantSeedTransport(provider, wallet, deployment),
      emit: (event) => console.log(JSON.stringify(event)) });
    console.log(JSON.stringify({ event: "grant-seed-result", ...result }));
  } finally { journal?.close(); provider.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ event: "error", code: error instanceof GrantSeedError || error instanceof GrantError ? error.message : "SEED_FAILED" }));
    process.exitCode = 1;
  });
}
