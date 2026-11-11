import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Interface } from "ethers";
import {
  SBT_ABI, SeedError, parseDeployment, parseSeedConfig, seedDemo,
  type SeedClient, type SeedEvent, type Submitted,
} from "../scripts/seed-demo.ts";

const FUNDER = "0x0000000000000000000000000000000000000011";
const NORMAL = "0x0000000000000000000000000000000000000022";
const STUDENT = "0x0000000000000000000000000000000000000033";
const ISSUER = "0x0000000000000000000000000000000000000044";
const SBT = "0x0000000000000000000000000000000000000055";
const HASH = `0x${"ab".repeat(32)}`;

function rawConfig() {
  return { schemaVersion: 1, chainId: 20261, funder: FUNDER,
    normal: { address: NORMAL, targetBalanceWei: "10000000000000000000000" },
    student: { address: STUDENT, targetBalanceWei: "10000000000000000000000", expiresAt: "2000" } };
}

function fixture() {
  const config = parseSeedConfig(rawConfig());
  const balances = new Map([[NORMAL, 2n], [STUDENT, 10n]]);
  const credentials = new Map([
    [NORMAL, { tokenId: 0n, expiresAt: 0n, tier: 0 }],
    [STUDENT, { tokenId: 0n, expiresAt: 0n, tier: 0 }],
  ]);
  const writes: { kind: string; address: string; value: bigint }[] = [];
  const events: SeedEvent[] = [];
  let nonce = 0;
  let ready = 0;
  const result = (effect: () => void): Submitted => {
    const hash = `0x${(++nonce).toString(16).padStart(64, "0")}`;
    return { hash, wait: async () => { effect(); return { hash, status: 1, blockNumber: nonce }; } };
  };
  const client: SeedClient = {
    sbtAddress: SBT,
    chainId: async () => 20261n,
    timestamp: async () => 1000n,
    issuer: async () => ISSUER,
    codeHash: async () => HASH,
    balance: async (address) => balances.get(address) ?? 0n,
    credential: async (address) => credentials.get(address)!,
    assertReady: async (funder, issuer, needsMint) => {
      ready++;
      assert.equal(funder, FUNDER); assert.equal(issuer, ISSUER);
      assert.equal(needsMint, credentials.get(STUDENT)!.tokenId === 0n);
    },
    fund: async (address, value) => {
      writes.push({ kind: "fund", address, value });
      return result(() => balances.set(address, (balances.get(address) ?? 0n) + value));
    },
    mint: async (address, value) => {
      writes.push({ kind: "mint", address, value });
      return result(() => credentials.set(address, { tokenId: 1n, expiresAt: value, tier: 1 }));
    },
  };
  return { config, balances, credentials, writes, events, client, options: { apply: true, emit: (e: SeedEvent) => events.push(e) }, ready: () => ready };
}

test("public config preserves large wei and validates fixed UTC expiry", () => {
  const result = parseSeedConfig(rawConfig());
  assert.equal(result.normal.targetBalanceWei, 10000000000000000000000n);
  assert.equal(result.student.expiresAt, 2000n);
});

for (const [field, value] of [
  ["schemaVersion", 2], ["chainId", 43113], ["chainId", "20261"], ["funder", NORMAL],
  ["funder", "0x0000000000000000000000000000000000000000"],
  ["funder", "secret-private-key"],
] as const) {
  test(`rejects invalid config ${field}=${String(value)}`, () => {
    assert.throws(() => parseSeedConfig({ ...rawConfig(), [field]: value }), SeedError);
  });
}

for (const value of ["0", "-1", "01", "1.1", "1e20", 1000, "0x10", " 1", String(1n << 256n)]) {
  test(`rejects noncanonical/overflow amount ${String(value)}`, () => {
    const raw = rawConfig();
    assert.throws(() => parseSeedConfig({ ...raw, normal: { ...raw.normal, targetBalanceWei: value } }), SeedError);
  });
}

test("rejects private key or unexpected fields in public config", () => {
  assert.throws(() => parseSeedConfig({ ...rawConfig(), privateKey: "secret" }), /INVALID_CONFIG_FIELDS/);
  const raw = rawConfig();
  assert.throws(() => parseSeedConfig({ ...raw, student: { ...raw.student, privateKey: "secret" } }), /INVALID_CONFIG_FIELDS/);
  assert.throws(() => parseSeedConfig({ ...raw, student: { ...raw.student, expiresAt: String(1n << 64n) } }), SeedError);
});

test("deployment parser uses L06 ABI and checks readiness and chain", () => {
  const deployment = { schemaVersion: 1, status: "deployed", chainId: 20261,
    contracts: { StudentSBTIdentity: { address: SBT, abi: JSON.parse(new Interface(SBT_ABI).formatJson()), runtimeCodeHash: HASH } } };
  assert.equal(parseDeployment(deployment).address, SBT);
  assert.equal(parseDeployment(deployment).codeHash, HASH);
  for (const change of [{ status: "unconfigured" }, { chainId: 1 }, { schemaVersion: 2 }]) {
    assert.throws(() => parseDeployment({ ...deployment, ...change }), /DEPLOYMENT_NOT_READY/);
  }
  assert.throws(() => parseDeployment({ ...deployment, contracts: { StudentSBTIdentity: { address: SBT, abi: [] } } }), /INVALID_DEPLOYMENT_ABI/);
  assert.throws(() => parseDeployment({ ...deployment, contracts: { StudentSBTIdentity: { ...deployment.contracts.StudentSBTIdentity, runtimeCodeHash: "secret" } } }), /INVALID_DEPLOYMENT_CODE_HASH/);
});

test("default dry-run reads complete state without keys or writes", async () => {
  const f = fixture();
  await seedDemo(f.config, f.client, { emit: (e) => f.events.push(e) });
  assert.equal(f.ready(), 0);
  assert.deepEqual(f.writes, []);
  assert.equal(f.events.at(-1)?.mode, "dry-run");
  assert.equal(f.events.filter((e) => e.event === "account").length, 2);
});

test("fresh seed sends only deficits, mints tier1 and verifies receipts", async () => {
  const f = fixture();
  await seedDemo(f.config, f.client, f.options);
  assert.deepEqual(f.writes, [
    { kind: "fund", address: NORMAL, value: f.config.normal.targetBalanceWei - 2n },
    { kind: "fund", address: STUDENT, value: f.config.student.targetBalanceWei - 10n },
    { kind: "mint", address: STUDENT, value: 2000n },
  ]);
  assert.equal(f.events.filter((e) => e.event === "submitted").length, 3);
  assert.equal(f.events.filter((e) => e.event === "confirmed").length, 3);
  assert.equal(f.events.at(-1)?.event, "complete");
  assert.equal(f.events.find((e) => e.event === "account" && e.role === "student")?.tier, 1);
});

test("second run sends no extra funding and never re-mints", async () => {
  const f = fixture();
  await seedDemo(f.config, f.client, f.options);
  f.writes.length = 0;
  await seedDemo(f.config, f.client, f.options);
  assert.deepEqual(f.writes, []);
});

test("existing longer-lived credential and higher balances are preserved", async () => {
  const f = fixture();
  f.balances.set(NORMAL, f.config.normal.targetBalanceWei + 5n);
  f.balances.set(STUDENT, f.config.student.targetBalanceWei + 1n);
  f.credentials.set(STUDENT, { tokenId: 44n, expiresAt: 3000n, tier: 1 });
  await seedDemo(f.config, f.client, f.options);
  assert.deepEqual(f.writes, []);
  assert.equal(f.credentials.get(STUDENT)?.tokenId, 44n);
});

for (const state of [
  { tokenId: 1n, expiresAt: 999n, tier: 0 },
  { tokenId: 1n, expiresAt: 1999n, tier: 1 },
  { tokenId: 0n, expiresAt: 0n, tier: 1 },
  { tokenId: 1n, expiresAt: 3000n, tier: 2 },
]) {
  test(`conflicting student credential ${JSON.stringify(state, (_, v) => typeof v === "bigint" ? v.toString() : v)} fails before funding`, async () => {
    const f = fixture(); f.credentials.set(STUDENT, state);
    await assert.rejects(seedDemo(f.config, f.client, f.options), /STUDENT_CREDENTIAL_REQUIRES_RESET/);
    assert.deepEqual(f.writes, []);
  });
}

test("normal wallet with active or expired card fails before any funding", async () => {
  for (const expiresAt of [999n, 2000n]) {
    const f = fixture(); f.credentials.set(NORMAL, { tokenId: 1n, expiresAt, tier: expiresAt < 1000n ? 0 : 1 });
    await assert.rejects(seedDemo(f.config, f.client, f.options), /NORMAL_WALLET_HAS_CREDENTIAL/);
    assert.deepEqual(f.writes, []);
  }
});

test("wrong chain and mismatched bytecode fail before writes", async () => {
  const f = fixture();
  await assert.rejects(seedDemo(f.config, { ...f.client, chainId: async () => 43113n }, f.options), /WRONG_CHAIN/);
  await assert.rejects(seedDemo(f.config, f.client, { ...f.options, expectedCodeHash: `0x${"00".repeat(32)}` }), /SBT_CODE_MISMATCH/);
  assert.deepEqual(f.writes, []);
});

test("expired requested seed is rejected using chain time", async () => {
  const f = fixture();
  f.config.student.expiresAt = 1000n;
  await assert.rejects(seedDemo(f.config, f.client, f.options), /CONFIG_EXPIRY_NOT_FUTURE/);
  assert.deepEqual(f.writes, []);
});

test("signer validation happens before first fund transaction", async () => {
  const f = fixture();
  f.client.assertReady = async () => { throw new SeedError("ISSUER_KEY_MISMATCH"); };
  await assert.rejects(seedDemo(f.config, f.client, f.options), /ISSUER_KEY_MISMATCH/);
  assert.deepEqual(f.writes, []);
});

test("failed receipt stops seed and retains public pending hash", async () => {
  const f = fixture();
  f.client.fund = async () => ({ hash: HASH, wait: async () => ({ hash: HASH, status: 0, blockNumber: 12 }) });
  await assert.rejects(seedDemo(f.config, f.client, f.options), /TRANSACTION_NOT_CONFIRMED/);
  assert.equal(f.events.at(-1)?.event, "submitted");
  assert.equal(f.events.at(-1)?.transactionHash, HASH);
  assert.equal(f.events.some((e) => e.event === "complete"), false);
});

test("chain is checked again immediately before each send", async () => {
  const f = fixture(); let calls = 0;
  f.client.chainId = async () => ++calls === 1 ? 20261n : 1n;
  await assert.rejects(seedDemo(f.config, f.client, f.options), /WRONG_CHAIN/);
  assert.deepEqual(f.writes, []);
});

test("partial previous funding is resumed without duplicating confirmed top-up", async () => {
  const f = fixture();
  f.balances.set(NORMAL, f.config.normal.targetBalanceWei);
  await seedDemo(f.config, f.client, f.options);
  assert.deepEqual(f.writes.map((w) => [w.kind, w.address]), [["fund", STUDENT], ["mint", STUDENT]]);
});

test("receipt success with wrong effects cannot report completion", async () => {
  const f = fixture();
  f.client.mint = async () => ({ hash: HASH, wait: async () => ({ hash: HASH, status: 1, blockNumber: 12 }) });
  await assert.rejects(seedDemo(f.config, f.client, f.options), /POST_SEED_VERIFICATION_FAILED/);
  assert.equal(f.events.some((e) => e.event === "complete"), false);
});

test("ABI parser rejects changed output types even when selector matches", () => {
  const abi = [...SBT_ABI].map((entry) => entry.replace("returns (uint8)", "returns (uint256)"));
  assert.throws(() => parseDeployment({ schemaVersion: 1, chainId: 20261, status: "deployed", contracts: {
    StudentSBTIdentity: { address: SBT, abi },
  } }), /INVALID_DEPLOYMENT_ABI/);
});

test("ABI parser accepts compiler-generated parameter names", () => {
  const abi = [
    "function issuer() view returns (address)",
    "function credentials(address wallet) view returns (uint256 tokenId,uint64 expiresAt)",
    "function tierOf(address wallet) view returns (uint8)",
    "function mint(address wallet,uint64 expiresAt) returns (uint256 tokenId)",
  ];
  assert.equal(parseDeployment({ schemaVersion: 1, chainId: 20261, status: "deployed", contracts: {
    StudentSBTIdentity: { address: SBT, abi },
  } }).address, SBT);
});

test("CLI reports sanitized failures without RPC credentials or signing keys", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "intracampus-b03-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accounts = join(directory, "accounts.json");
  await writeFile(accounts, JSON.stringify(rawConfig()));
  const result = await new Promise<{ stdout: string; stderr: string; code: number | string | undefined }>((resolve) => {
    execFile(process.execPath, [fileURLToPath(new URL("../scripts/seed-demo.ts", import.meta.url)), "--accounts", accounts, "--sbt", SBT], {
      env: { ...process.env, INTRACAMPUS_RPC_URL: "https://username:private-rpc-password@invalid.example/rpc",
        SEED_FUNDER_PRIVATE_KEY: "secret-funder-key", SEED_ISSUER_PRIVATE_KEY: "secret-issuer-key" },
      windowsHide: true,
    }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error?.code ?? undefined }));
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /RPC_NOT_CONFIGURED/);
  assert.doesNotMatch(result.stdout + result.stderr, /username|private-rpc-password|secret-funder-key|secret-issuer-key/);
});
