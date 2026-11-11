import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  Contract, Interface, JsonRpcProvider, Wallet, ZeroAddress, getAddress, keccak256,
} from "ethers";
import { campusNetwork } from "@intracampus/network";

export const SBT_ABI = [
  "function issuer() view returns (address)",
  "function credentials(address) view returns (uint256 tokenId,uint64 expiresAt)",
  "function tierOf(address) view returns (uint8)",
  "function mint(address,uint64) returns (uint256)",
] as const;

export class SeedError extends Error {
  constructor(code: string) { super(code); this.name = "SeedError"; }
}

type Account = { address: string; targetBalanceWei: bigint };
export type SeedConfig = {
  chainId: number;
  funder: string;
  normal: Account;
  student: Account & { expiresAt: bigint };
};
type Credential = { tokenId: bigint; expiresAt: bigint; tier: number };
type Snapshot = Credential & { address: string; balanceWei: bigint };
type SeedReceipt = { hash: string; status: number; blockNumber: number };
export type Submitted = { hash: string; wait: () => Promise<SeedReceipt> };
export type SeedClient = {
  sbtAddress: string;
  chainId: () => Promise<bigint>;
  timestamp: () => Promise<bigint>;
  issuer: () => Promise<string>;
  codeHash: () => Promise<string>;
  balance: (address: string) => Promise<bigint>;
  credential: (address: string) => Promise<Credential>;
  assertReady: (funder: string, issuer: string, needsMint: boolean) => Promise<void>;
  fund: (address: string, value: bigint) => Promise<Submitted>;
  mint: (address: string, expiresAt: bigint) => Promise<Submitted>;
};
export type SeedEvent = Record<string, string | number | boolean | null>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SeedError("INVALID_CONFIG");
  return value as Record<string, unknown>;
}

function address(value: unknown): string {
  try {
    if (typeof value !== "string") throw new Error();
    const result = getAddress(value);
    if (result === ZeroAddress) throw new Error();
    return result;
  } catch { throw new SeedError("INVALID_ADDRESS"); }
}

function uint(value: unknown, max: bigint): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new SeedError("INVALID_INTEGER");
  const result = BigInt(value);
  if (result <= 0n || result > max) throw new SeedError("INVALID_INTEGER");
  return result;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
    throw new SeedError("INVALID_CONFIG_FIELDS");
  }
}

export function parseSeedConfig(value: unknown): SeedConfig {
  const data = record(value);
  exactKeys(data, ["schemaVersion", "chainId", "funder", "normal", "student"]);
  if (data.schemaVersion !== 1 || data.chainId !== campusNetwork.chainId) throw new SeedError("INVALID_CONFIG_CHAIN_OR_VERSION");
  const normal = record(data.normal);
  const student = record(data.student);
  exactKeys(normal, ["address", "targetBalanceWei"]);
  exactKeys(student, ["address", "targetBalanceWei", "expiresAt"]);
  const result = {
    chainId: campusNetwork.chainId,
    funder: address(data.funder),
    normal: { address: address(normal.address), targetBalanceWei: uint(normal.targetBalanceWei, (1n << 256n) - 1n) },
    student: {
      address: address(student.address),
      targetBalanceWei: uint(student.targetBalanceWei, (1n << 256n) - 1n),
      expiresAt: uint(student.expiresAt, (1n << 64n) - 1n),
    },
  };
  if (new Set([result.funder, result.normal.address, result.student.address]).size !== 3) throw new SeedError("DUPLICATE_ACCOUNTS");
  return result;
}

export function parseDeployment(value: unknown): { address: string; codeHash?: string; abi: unknown[] } {
  const data = record(value);
  if (data.schemaVersion !== 1 || data.chainId !== campusNetwork.chainId || data.status !== "deployed") {
    throw new SeedError("DEPLOYMENT_NOT_READY");
  }
  const sbt = record(record(data.contracts).StudentSBTIdentity);
  if (!Array.isArray(sbt.abi)) throw new SeedError("INVALID_DEPLOYMENT_ABI");
  try {
    const supplied = new Interface(sbt.abi);
    const required = new Interface(SBT_ABI);
    for (const fragment of required.fragments) {
      // ABI parameter names do not affect the call; types, outputs and mutability do.
      const expected = fragment.format("minimal");
      if (!supplied.fragments.some((candidate) => candidate.format("minimal") === expected)) throw new Error();
    }
  } catch { throw new SeedError("INVALID_DEPLOYMENT_ABI"); }
  const codeHash = sbt.runtimeCodeHash;
  if (codeHash !== undefined && (typeof codeHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(codeHash))) {
    throw new SeedError("INVALID_DEPLOYMENT_CODE_HASH");
  }
  return { address: address(sbt.address), codeHash: codeHash as string | undefined, abi: sbt.abi };
}

async function assertChain(client: SeedClient): Promise<void> {
  if (await client.chainId() !== BigInt(campusNetwork.chainId)) throw new SeedError("WRONG_CHAIN");
}

async function snapshot(client: SeedClient, target: Account): Promise<Snapshot> {
  return { address: target.address, balanceWei: await client.balance(target.address), ...await client.credential(target.address) };
}

function logSnapshot(emit: (event: SeedEvent) => void, role: string, state: Snapshot): void {
  emit({ event: "account", role, address: state.address, balanceWei: state.balanceWei.toString(),
    tokenId: state.tokenId.toString(), expiresAt: state.expiresAt.toString(), tier: state.tier });
}

/** Reads and validates the entire plan before any write. Re-running tops up deficits only. */
export async function seedDemo(
  config: SeedConfig, client: SeedClient,
  { apply = false, expectedCodeHash, emit = () => {} }: {
    apply?: boolean; expectedCodeHash?: string; emit?: (event: SeedEvent) => void;
  } = {},
): Promise<void> {
  await assertChain(client);
  const codeHash = await client.codeHash();
  if (expectedCodeHash && codeHash.toLowerCase() !== expectedCodeHash.toLowerCase()) throw new SeedError("SBT_CODE_MISMATCH");
  const now = await client.timestamp();
  if (config.student.expiresAt <= now) throw new SeedError("CONFIG_EXPIRY_NOT_FUTURE");
  const issuer = address(await client.issuer());
  const states = [await snapshot(client, config.normal), await snapshot(client, config.student)];
  const [normal, student] = states;
  if (normal.tokenId !== 0n || normal.tier !== 0) throw new SeedError("NORMAL_WALLET_HAS_CREDENTIAL");
  const needsMint = student.tokenId === 0n;
  if (needsMint ? student.tier !== 0 : student.tier !== 1 || student.expiresAt < config.student.expiresAt) {
    throw new SeedError("STUDENT_CREDENTIAL_REQUIRES_RESET");
  }
  const targets = [config.normal, config.student];
  emit({ event: "plan", mode: apply ? "apply" : "dry-run", chainId: config.chainId,
    studentSbt: client.sbtAddress, funder: config.funder, issuer, codeHash });
  for (let i = 0; i < targets.length; i++) {
    const deficit = targets[i].targetBalanceWei > states[i].balanceWei ? targets[i].targetBalanceWei - states[i].balanceWei : 0n;
    emit({ event: "funding-plan", address: targets[i].address, amountWei: deficit.toString() });
  }
  emit({ event: "credential-plan", address: student.address, action: needsMint ? "mint" : "skip", expiresAt: config.student.expiresAt.toString() });
  if (apply) {
    await client.assertReady(config.funder, issuer, needsMint);
    async function confirm(action: string, submit: () => Promise<Submitted>): Promise<void> {
      await assertChain(client);
      const tx = await submit();
      emit({ event: "submitted", action, transactionHash: tx.hash });
      const receipt = await tx.wait();
      if (receipt.status !== 1 || receipt.hash.toLowerCase() !== tx.hash.toLowerCase()) throw new SeedError("TRANSACTION_NOT_CONFIRMED");
      emit({ event: "confirmed", action, transactionHash: receipt.hash, blockNumber: receipt.blockNumber });
    }
    for (const target of targets) {
      // Refresh after each confirmed transaction, including a partially completed earlier run.
      const balance = await client.balance(target.address);
      if (balance < target.targetBalanceWei) {
        await confirm("fund", () => client.fund(target.address, target.targetBalanceWei - balance));
      }
    }
    if (needsMint) {
      const current = await client.credential(student.address);
      if (current.tokenId !== 0n) throw new SeedError("CREDENTIAL_CHANGED_DURING_SEED");
      if (config.student.expiresAt <= await client.timestamp()) throw new SeedError("CONFIG_EXPIRY_NOT_FUTURE");
      await confirm("mint", () => client.mint(student.address, config.student.expiresAt));
    }
    await assertChain(client);
    const finalNormal = await snapshot(client, config.normal);
    const finalStudent = await snapshot(client, config.student);
    logSnapshot(emit, "normal", finalNormal);
    logSnapshot(emit, "student", finalStudent);
    if (finalNormal.tier !== 0 || finalNormal.tokenId !== 0n || finalStudent.tier !== 1
      || finalStudent.expiresAt < config.student.expiresAt
      || finalNormal.balanceWei < config.normal.targetBalanceWei || finalStudent.balanceWei < config.student.targetBalanceWei) {
      throw new SeedError("POST_SEED_VERIFICATION_FAILED");
    }
    emit({ event: "complete", mode: "apply", chainId: config.chainId });
  } else {
    logSnapshot(emit, "normal", normal);
    logSnapshot(emit, "student", student);
    emit({ event: "complete", mode: "dry-run", chainId: config.chainId });
  }
}

function readKey(value: string | undefined): string {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new SeedError("SIGNING_KEY_NOT_CONFIGURED");
  return value;
}

export function createSeedClient(provider: JsonRpcProvider, sbtAddress: string): SeedClient {
  const sbt = new Contract(sbtAddress, SBT_ABI, provider);
  let funder: Wallet | undefined;
  let issuer: Wallet | undefined;
  async function assertNoPending(signer: Wallet) {
    const [latest, pending] = await Promise.all([
      provider.getTransactionCount(signer.address, "latest"), provider.getTransactionCount(signer.address, "pending"),
    ]);
    if (latest !== pending) throw new SeedError("SIGNER_HAS_PENDING_TRANSACTIONS");
  }
  async function submitted(tx: { hash: string; wait: (confirmations?: number, timeout?: number) => Promise<{ hash: string; status: number | null; blockNumber: number } | null> }): Promise<Submitted> {
    return { hash: tx.hash, wait: async () => {
      const receipt = await tx.wait(1, 120_000);
      if (!receipt) throw new SeedError("RECEIPT_NOT_AVAILABLE");
      return { hash: receipt.hash, status: receipt.status ?? 0, blockNumber: receipt.blockNumber };
    } };
  }
  return {
    sbtAddress,
    chainId: async () => BigInt(await provider.send("eth_chainId", [])),
    timestamp: async () => {
      const block = await provider.getBlock("latest");
      if (!block) throw new SeedError("LATEST_BLOCK_NOT_AVAILABLE");
      return BigInt(block.timestamp);
    },
    issuer: async () => address(await sbt.issuer()),
    codeHash: async () => {
      const code = await provider.getCode(sbtAddress);
      if (code === "0x") throw new SeedError("SBT_NOT_DEPLOYED");
      return keccak256(code);
    },
    balance: (wallet) => provider.getBalance(wallet),
    credential: async (wallet) => {
      const [credential, tier] = await Promise.all([sbt.credentials(wallet), sbt.tierOf(wallet)]);
      return { tokenId: BigInt(credential[0]), expiresAt: BigInt(credential[1]), tier: Number(tier) };
    },
    assertReady: async (expectedFunder, expectedIssuer, needsMint) => {
      funder = new Wallet(readKey(process.env.SEED_FUNDER_PRIVATE_KEY), provider);
      if (funder.address !== expectedFunder) throw new SeedError("FUNDER_KEY_MISMATCH");
      await assertNoPending(funder);
      if (needsMint) {
        issuer = new Wallet(readKey(process.env.SEED_ISSUER_PRIVATE_KEY), provider);
        if (issuer.address !== expectedIssuer) throw new SeedError("ISSUER_KEY_MISMATCH");
        await assertNoPending(issuer);
        if (await provider.getBalance(issuer.address) === 0n) throw new SeedError("ISSUER_REQUIRES_GAS");
      }
    },
    fund: async (wallet, value) => {
      if (!funder) throw new SeedError("SIGNER_NOT_READY");
      await assertNoPending(funder);
      return submitted(await funder.sendTransaction({ to: wallet, value }));
    },
    mint: async (wallet, expiresAt) => {
      if (!issuer) throw new SeedError("SIGNER_NOT_READY");
      await assertNoPending(issuer);
      return submitted(await new Contract(sbtAddress, SBT_ABI, issuer).mint(wallet, expiresAt));
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    accounts: { type: "string" }, deployment: { type: "string" }, sbt: { type: "string" },
    apply: { type: "boolean", default: false }, help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log("seed-demo --accounts <public.json> (--deployment <intracampus.json> | --sbt <address>) [--apply]\nDefault: read-only dry-run. RPC and signing keys come from backend/.env. See docs/demo-accounts.md.");
    return;
  }
  if (!values.accounts || Boolean(values.deployment) === Boolean(values.sbt)) throw new SeedError("USAGE_SEE_HELP");
  const config = parseSeedConfig(JSON.parse(await readFile(resolve(values.accounts), "utf8")));
  const deployment = values.deployment ? parseDeployment(JSON.parse(await readFile(resolve(values.deployment), "utf8"))) : { address: address(values.sbt), codeHash: undefined };
  if ([config.funder, config.normal.address, config.student.address].includes(deployment.address)) throw new SeedError("SBT_ADDRESS_IS_DEMO_ACCOUNT");
  const rpc = process.env.INTRACAMPUS_RPC_URL;
  try {
    const url = new URL(rpc ?? "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { throw new SeedError("RPC_NOT_CONFIGURED"); }
  const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  try {
    await seedDemo(config, createSeedClient(provider, deployment.address), {
      apply: values.apply, expectedCodeHash: deployment.codeHash,
      emit: (event) => console.log(JSON.stringify(event)),
    });
  } finally { provider.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Ethers/RPC error objects may contain request bodies, credentials or signed transactions.
    console.error(JSON.stringify({ event: "error", code: error instanceof SeedError ? error.message : "SEED_FAILED_CHECK_RPC_CONFIG_AND_RECEIPTS" }));
    process.exitCode = 1;
  });
}
