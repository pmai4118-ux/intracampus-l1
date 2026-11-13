import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Interface, Transaction, Wallet, id, keccak256 } from "ethers";
import { requireDeployment } from "@intracampus/network";
import template from "../../deployments/intracampus.json" with { type: "json" };
import { seedGrant, createGrantSeedTransport } from "../scripts/seed-grants.ts";
import { GrantError } from "../src/modules/grants/grants.types.ts";
import type { GrantSeedReader, GrantSeedTransport } from "../scripts/seed-grants.ts";
import { GrantSeedJournal } from "../src/modules/grants/grants.seed-repository.ts";
import type { VerifiedGrantEvent } from "../src/modules/grants/grants.types.ts";
import { parseSeedConfig } from "../scripts/seed-demo.ts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const amount = 5000000000000000000000n;
function setup() {
  const signer = Wallet.createRandom();
  const input = structuredClone(template) as Record<string, any>;
  Object.assign(input, { status: "deployed", environment: "local-anvil" });
  Object.values(input.contracts).forEach((entry, index) => Object.assign(entry as object, {
    address: addr(index + 1), transactionHash: hash(index + 1), blockHash: hash(index + 1),
    blockNumber: index + 1, runtimeCodeHash: hash(index + 10),
  }));
  input.roles = { deployer: signer.address, sbtIssuer: signer.address, grantIssuer: signer.address, posSigner: addr(15) };
  input.merchants = { parking: { address: addr(20), category: id("PARKING") }, canteen: { address: addr(21), category: id("FOOD") } };
  const deployment = requireDeployment(input, { allowLocal: true });
  const config = parseSeedConfig({ schemaVersion: 1, chainId: 20261, funder: addr(30),
    normal: { address: addr(31), targetBalanceWei: "10000000000000000000000" },
    student: { address: addr(32), targetBalanceWei: "10000000000000000000000", expiresAt: "1900000000" } });
  const abi = new Interface(deployment.contracts.PurposeBoundGrantVault.abi);
  const chain = { balance: 0n, events: [] as VerifiedGrantEvent[], nonce: 0, allowed: true,
    failure: "", mode: "mine", receiptMismatch: false, prepareCount: 0 };
  const reader: GrantSeedReader = {
    deployment,
    snapshot: async () => {
      if (chain.failure) throw new Error(chain.failure);
      return { blockNumber: 100, blockHash: hash(100), balanceWei: chain.balance, merchantAllowed: chain.allowed };
    },
    issued: async () => chain.events,
    verifyReceipt: async (txHash) => {
      const events = chain.events.filter((event) => event.transactionHash === txHash);
      if (!events.length) return null;
      return chain.receiptMismatch ? events.map((event) => ({ ...event, amountWei: "1" })) : events;
    },
  };
  const transport: GrantSeedTransport = {
    address: signer.address,
    prepare: async (beneficiary, category, value) => {
      chain.prepareCount++;
      const rawTransaction = await signer.signTransaction({ chainId: 20261, to: addr(3), value,
        data: abi.encodeFunctionData("grant", [beneficiary, category]), type: 2, nonce: chain.nonce,
        gasLimit: 100000, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n });
      return { rawTransaction, hash: keccak256(rawTransaction), nonce: chain.nonce };
    },
    broadcast: async (raw) => {
      const tx = Transaction.from(raw);
      if (chain.mode === "unknown") throw new Error("RPC included SECRET and raw transaction");
      const [beneficiary, category] = abi.decodeFunctionData("grant", tx.data);
      chain.balance += tx.value; chain.nonce++;
      chain.events.push({ event: "GrantIssued", transactionHash: tx.hash!, blockNumber: 100, blockHash: hash(100),
        logIndex: 0, beneficiary, category, amountWei: tx.value.toString(), balanceWei: chain.balance.toString(), issuer: signer.address });
      if (chain.mode === "lost-response") throw new Error("RPC_SECRET");
      return tx.hash!;
    },
  };
  return { config, reader, transport, chain, signer };
}

test("dry-run plans exact FOOD allocation without signer or state changes", async () => {
  const f = setup();
  assert.deepEqual(await seedGrant({ config: f.config, reader: f.reader }), {
    mode: "dry-run", status: "planned", beneficiary: f.config.student.address,
    amountWei: "5000000000000000000000", balanceWei: "0" });
  assert.equal(f.chain.balance, 0n); assert.equal(f.chain.nonce, 0);
});
test("applies once; reopened journal prevents refill after spending to 4000", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b05-journal-")); const path = join(dir, "seed.sqlite");
  const f = setup(); let journal = new GrantSeedJournal(path);
  try {
    assert.equal((await seedGrant({ ...f, journal, apply: true }) as any).status, "confirmed");
    assert.equal(f.chain.balance, amount); assert.equal(f.chain.events[0].category, id("FOOD"));
    f.chain.balance -= 1000000000000000000000n;
    journal.close(); journal = new GrantSeedJournal(path);
    const second = await seedGrant({ ...f, journal, apply: true }) as any;
    assert.equal(second.status, "already-issued"); assert.equal(second.balanceWei, "4000000000000000000000");
    assert.equal(f.chain.nonce, 1); assert.equal(f.chain.prepareCount, 1);
    assert.equal((await readFile(path)).includes(Buffer.from("rawTransaction")), false);
  } finally { journal.close(); await rm(dir, { recursive: true, force: true }); }
});
test("verified history prevents refill without old journal even after all funds spent", async () => {
  const f = setup(); const journal = new GrantSeedJournal(":memory:");
  try {
    await seedGrant({ ...f, journal, apply: true }); f.chain.balance = 0n;
    const result = await seedGrant({ config: f.config, reader: f.reader }) as any;
    assert.equal(result.status, "already-issued"); assert.equal(result.balanceWei, "0"); assert.equal(f.chain.nonce, 1);
  } finally { journal.close(); }
});
test("lost response after mining reconciles receipt without another issuance", async () => {
  const f = setup(); f.chain.mode = "lost-response"; const journal = new GrantSeedJournal(":memory:");
  try {
    assert.equal((await seedGrant({ ...f, journal, apply: true }) as any).status, "confirmed");
    await seedGrant({ ...f, journal, apply: true }); assert.equal(f.chain.nonce, 1);
  } finally { journal.close(); }
});
test("unknown broadcast persists across restart and blocks another signed grant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "b05-unknown-")); const path = join(dir, "seed.sqlite");
  const f = setup(); f.chain.mode = "unknown"; let journal = new GrantSeedJournal(path);
  try {
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /SEED_OUTCOME_UNKNOWN/);
    journal.close(); journal = new GrantSeedJournal(path); f.chain.mode = "mine";
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /SEED_OUTCOME_UNKNOWN/);
    assert.equal(f.chain.balance, 0n); assert.equal(f.chain.prepareCount, 1);
  } finally { journal.close(); await rm(dir, { recursive: true, force: true }); }
});
for (const code of ["WRONG_CHAIN", "ISSUER_MISMATCH", "DEPLOYMENT_NOT_CONFIGURED", "RPC_UNAVAILABLE"]) {
  test(`preflight ${code} never broadcasts`, async () => {
    const f = setup(); f.chain.failure = code; const journal = new GrantSeedJournal(":memory:");
    try { await assert.rejects(seedGrant({ ...f, journal, apply: true }), new RegExp(code)); assert.equal(f.chain.nonce, 0); }
    finally { journal.close(); }
  });
}
test("issuer key mismatch and disabled canteen block signing", async () => {
  const f = setup(); const journal = new GrantSeedJournal(":memory:");
  try {
    f.transport.address = addr(99);
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /ISSUER_KEY_MISMATCH/);
    f.chain.allowed = false;
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /MERCHANT_NOT_ALLOWED/);
    assert.equal(f.chain.prepareCount, 0);
  } finally { journal.close(); }
});
test("mismatched receipt amount cannot report confirmed or issue again", async () => {
  const f = setup(); f.chain.receiptMismatch = true; const journal = new GrantSeedJournal(":memory:");
  try {
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /SEED_RECEIPT_MISMATCH/);
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /SEED_RECEIPT_MISMATCH/);
    assert.equal(f.chain.nonce, 1);
  } finally { journal.close(); }
});
test("unexpected existing issuance blocks guessing a top-up or new batch", async () => {
  const f = setup(); const journal = new GrantSeedJournal(":memory:");
  try {
    await seedGrant({ ...f, journal, apply: true }); f.chain.events[0].amountWei = "6000000000000000000000";
    await assert.rejects(seedGrant({ config: f.config, reader: f.reader }), /EXISTING_GRANT_CONFLICT/);
    assert.equal(f.chain.nonce, 1);
  } finally { journal.close(); }
});
test("concurrent calls sharing a journal cannot grant twice", async () => {
  const f = setup(); const journal = new GrantSeedJournal(":memory:");
  try {
    const result = await Promise.allSettled([seedGrant({ ...f, journal, apply: true }), seedGrant({ ...f, journal, apply: true })]);
    assert.ok(result.some((r) => r.status === "fulfilled")); assert.equal(f.chain.balance, amount); assert.equal(f.chain.events.length, 1);
  } finally { journal.close(); }
});

test("signed transaction for another destination is rejected before journaling or broadcast", async () => {
  const f = setup(); const journal = new GrantSeedJournal(":memory:");
  const prepare = f.transport.prepare;
  f.transport.prepare = async (...args) => ({ ...await prepare(...args), hash: hash(999) });
  try {
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /INVALID_SIGNED_GRANT/);
    assert.equal(f.chain.nonce, 0);
  } finally { journal.close(); }
});

test("recovery reads balance after receipt verification instead of returning a stale snapshot", async () => {
  const f = setup(); const journal = new GrantSeedJournal(":memory:");
  try {
    await seedGrant({ ...f, journal, apply: true });
    f.chain.balance = 0n;
    const verify = f.reader.verifyReceipt;
    f.reader.verifyReceipt = async (...args) => { const events = await verify(...args); f.chain.balance = 4000000000000000000000n; return events; };
    assert.equal((await seedGrant({ ...f, journal, apply: true })).balanceWei, "4000000000000000000000");
  } finally { journal.close(); }
});

test("an unresolved broadcast exposes its public hash for operator reconciliation", async () => {
  const f = setup(); f.chain.mode = "unknown"; const journal = new GrantSeedJournal(":memory:");
  const notices: { event: string; transactionHash: string }[] = [];
  try {
    await assert.rejects(seedGrant({ ...f, journal, apply: true, emit: (notice) => notices.push(notice) }), /SEED_OUTCOME_UNKNOWN/);
    assert.equal(notices.length, 1); assert.equal(notices[0].event, "grant-seed-intent");
    assert.match(notices[0].transactionHash, /^0x[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(notices[0]).sort(), ["event", "transactionHash"]);
  } finally { journal.close(); }
});

test("real transport nonce failure before send releases durable intent so retry can succeed", async () => {
  const f = setup(); const journal = new GrantSeedJournal(":memory:");
  const normalBroadcast = f.transport.broadcast;
  const provider = { send: async (method: string) => method === "eth_chainId" ? "0x4f25" : "0x1" };
  const realTransport = createGrantSeedTransport(provider as any, new Wallet(f.signer.privateKey), f.reader.deployment);
  f.transport.broadcast = realTransport.broadcast;
  try {
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /ISSUER_NONCE_CHANGED/);
    assert.equal(f.chain.nonce, 0);
    f.transport.broadcast = normalBroadcast;
    assert.equal((await seedGrant({ ...f, journal, apply: true })).status, "confirmed");
    assert.equal(f.chain.nonce, 1);
  } finally { journal.close(); }
});

test("canonical reverted receipt survives restart and apply retires it before an explicit retry", async () => {
  const f = setup(); f.chain.mode = "unknown";
  const dir = await mkdtemp(join(tmpdir(), "b05-revert-")); const path = join(dir, "seed.sqlite");
  let journal = new GrantSeedJournal(path);
  try {
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /SEED_OUTCOME_UNKNOWN/);
    journal.close(); journal = new GrantSeedJournal(path);
    f.reader.verifyReceipt = async () => { throw new GrantError("TX_REVERTED"); };
    const plan = await seedGrant({ config: f.config, reader: f.reader, journal });
    assert.equal(plan.status, "planned"); assert.equal(plan.recovery, "canonical-revert");
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /SEED_REVERTED_RETRY_ALLOWED/);
    f.reader.verifyReceipt = async (hash) => f.chain.events.filter((event) => event.transactionHash === hash);
    f.chain.mode = "mine";
    assert.equal((await seedGrant({ ...f, journal, apply: true })).status, "confirmed");
    assert.equal(f.chain.nonce, 1);
  } finally { journal.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an unverified revert error never releases an ambiguous intent", async () => {
  const f = setup(); f.chain.mode = "unknown"; const journal = new GrantSeedJournal(":memory:");
  try {
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /SEED_OUTCOME_UNKNOWN/);
    f.reader.verifyReceipt = async () => { throw new Error("TX_REVERTED"); };
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /TX_REVERTED/);
    f.reader.verifyReceipt = async () => null;
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /SEED_OUTCOME_UNKNOWN/);
    assert.equal(f.chain.prepareCount, 1);
  } finally { journal.close(); }
});

test("a canonical revert on the first apply releases only that failed transaction", async () => {
  const f = setup(); const journal = new GrantSeedJournal(":memory:");
  const broadcast = f.transport.broadcast;
  f.transport.broadcast = async (raw) => { f.chain.nonce++; return keccak256(raw); };
  f.reader.verifyReceipt = async () => { throw new GrantError("TX_REVERTED"); };
  try {
    await assert.rejects(seedGrant({ ...f, journal, apply: true }), /SEED_REVERTED_RETRY_ALLOWED/);
    assert.equal(f.chain.balance, 0n);
    f.transport.broadcast = broadcast;
    f.reader.verifyReceipt = async (hash) => f.chain.events.filter((event) => event.transactionHash === hash);
    assert.equal((await seedGrant({ ...f, journal, apply: true })).status, "confirmed");
    assert.equal(f.chain.events.length, 1);
  } finally { journal.close(); }
});
