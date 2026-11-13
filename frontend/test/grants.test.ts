import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Interface } from "ethers";
import { GrantController, GrantUiError, encodeGrantSpend, grantConfig, grantJournalKey, lookupGrant, parseGrantAmount, parseGrantLookup, preflightGrant,
  type GrantConfig, type GrantIntent, type GrantSender } from "../lib/grants.ts";
import type { WalletRpc } from "../lib/wallet.ts";

const evidence = JSON.parse(readFileSync(new URL("../../docs/fixtures/b03-l05-l06-local.json", import.meta.url), "utf8"));
// Full ABI fixture only, never published as a production manifest.
const manifest = { ...evidence.manifest, environment: "avalanche-l1" };
const config = grantConfig(manifest);
const beneficiary = `0x${"12".repeat(20)}`, other = `0x${"34".repeat(20)}`;
const hash = `0x${"ab".repeat(32)}`, blockHash = `0x${"cd".repeat(32)}`;
const unit = BigInt(10) ** BigInt(18), amount = BigInt(1000) * unit;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const addressWord = (value: string) => `0x${value.slice(2).padStart(64, "0")}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const makeIntent = (patch: Partial<GrantIntent> = {}): GrantIntent => ({ schemaVersion: 1, id: crypto.randomUUID(), chainId: 20261, beneficiary,
  vault: config.vault, deploymentHash: config.deploymentHash, merchant: config.merchant, category: config.category,
  amountWei: amount.toString(), afterBlock: 10, recoveredHash: false, phase: "pending", hash, ...patch });
function body(balance = BigInt(5000) * unit, tx: "none" | "pending" | "verified" = "none"): Record<string, any> {
  return { schemaVersion: 1, status: "verified", chainId: 20261, beneficiary, vaultAddress: config.vault,
    category: { id: config.category, label: "FOOD" }, balanceWei: balance.toString(), block: { number: 12, hash: blockHash },
    allowedMerchants: [{ id: "canteen", address: config.merchant, allowed: true }],
    transaction: tx === "none" ? null : { hash, status: tx, events: tx === "pending" ? [] : [{ event: "GrantSpent", transactionHash: hash,
      blockNumber: 11, blockHash, logIndex: 0, beneficiary, merchant: config.merchant, category: config.category, amountWei: amount.toString(), balanceWei: balance.toString() }] } };
}
function mockRpc(overrides: Record<string, unknown> = {}, calls: Array<{ method: string; params: unknown[] }> = []): WalletRpc {
  return async (method, params) => {
    calls.push({ method, params });
    if (Object.hasOwn(overrides, method)) { const value = overrides[method]; if (value instanceof Error) throw value; return value; }
    if (method === "eth_chainId") return "0x4f25";
    if (method === "eth_getBlockByNumber") return { number: "0xa", hash: blockHash };
    if (method === "eth_call") {
      const tx = params[0] as { data: string };
      if (tx.data.startsWith("0x1f14df69")) return word(BigInt(5000) * unit);
      if (tx.data.startsWith("0x6f790f46")) return word(BigInt(1));
      if (tx.data === "0x6eca5042") return addressWord(config.registry);
      if (tx.data === "0x1d143848") return addressWord(config.issuer);
      if (tx.data.startsWith("0xe2f7cbfa")) return "0x";
    }
    throw Error("Unexpected RPC method");
  };
}
function harness(options: { fetcher?: typeof fetch; rpc?: WalletRpc; send?: GrantSender["sendTransaction"]; db?: Map<string, string>;
  store?: Pick<Storage, "getItem" | "setItem" | "removeItem">; lock?: (name: string, run: () => Promise<void>) => Promise<void> } = {}) {
  const db = options.db ?? new Map<string, string>();
  const store = options.store ?? { getItem: (key: string) => db.get(key) ?? null, setItem: (key: string, value: string) => { db.set(key, value); }, removeItem: (key: string) => { db.delete(key); } };
  const walletState = { address: beneficiary as string | null, chainId: BigInt(20261) as bigint | null, canProceed: true };
  let sends = 0;
  const wallet: GrantSender = { getSnapshot: () => walletState, sendTransaction: async (account, tx) => { sends++; return options.send ? options.send(account, tx) : hash; } };
  const fetcher: typeof fetch = options.fetcher ?? (async (url) => response(body(BigInt(4000) * unit, String(url).includes("txHash") ? "verified" : "none")));
  const controller = new GrantController({ config, rpc: options.rpc ?? mockRpc(), wallet, storage: store, fetcher, lock: options.lock ?? (async (_name, run) => run()), pollMs: 100_000 });
  return { controller, db, walletState, sends: () => sends };
}

test("only a validated L06 production manifest provides the FOOD vault", () => {
  assert.throws(() => grantConfig({ schemaVersion: 1, status: "unconfigured", chainId: 20261, abiVersion: 1 }));
  assert.throws(() => grantConfig(evidence.manifest));
  assert.equal(config.vault, manifest.contracts.PurposeBoundGrantVault.address);
  const wrong = structuredClone(manifest); wrong.contracts.PurposeBoundGrantVault.abi = [];
  assert.throws(() => grantConfig(wrong));
});
test("decimal amounts stay exact in wei and reject ambiguous or overflowing input", () => {
  assert.equal(parseGrantAmount("1000.000000000000000001"), amount + BigInt(1));
  assert.equal(parseGrantAmount("0.000000000000000001"), BigInt(1));
  for (const value of ["0", "-1", "01", "1,5", "1e3", ".5", "1.", "1.0000000000000000001", " ", "9".repeat(78)]) assert.throws(() => parseGrantAmount(value));
});
test("spend encoding agrees with the full compiled L05 ABI, no runtime ethers dependency", () => {
  const abi = new Interface(manifest.contracts.PurposeBoundGrantVault.abi);
  assert.equal(encodeGrantSpend(config, amount), abi.encodeFunctionData("spend", [config.merchant, config.category, amount]));
});
test("B05 verified zero differs from unverified/null and binds recipient/deployment", () => {
  assert.equal(parseGrantLookup(body(BigInt(0)), config, beneficiary).balanceWei, "0");
  for (const patch of [{ balanceWei: null }, { status: "unverified" }, { chainId: 43113 }, { beneficiary: other }, { vaultAddress: other }, { balanceWei: "1e3" }]) {
    assert.throws(() => parseGrantLookup({ ...body(), ...patch }, config, beneficiary));
  }
  assert.throws(() => parseGrantLookup({ ...body(), category: { id: manifest.merchants.parking.category, label: "FOOD" } }, config, beneficiary));
  assert.throws(() => parseGrantLookup({ ...body(), allowedMerchants: [{ id: "canteen", address: other, allowed: true }] }, config, beneficiary));
});
test("B05 confirms only this exact GrantSpent, never a pending hash or old event", () => {
  assert.equal(parseGrantLookup(body(BigInt(4000) * unit, "verified"), config, beneficiary, makeIntent()).transaction?.status, "verified");
  assert.equal(parseGrantLookup(body(amount, "pending"), config, beneficiary, makeIntent()).transaction?.status, "pending");
  for (const patch of [{ event: "GrantIssued" }, { beneficiary: other }, { merchant: other }, { amountWei: "1" }, { transactionHash: blockHash }, { category: blockHash }, { blockNumber: 10 }, { logIndex: -1 }]) {
    const value = body(amount, "verified"); Object.assign(value.transaction.events[0], patch);
    assert.throws(() => parseGrantLookup(value, config, beneficiary, makeIntent()), JSON.stringify(patch));
  }
  const duplicate = body(amount, "verified"); duplicate.transaction.events.push(duplicate.transaction.events[0]);
  assert.throws(() => parseGrantLookup(duplicate, config, beneficiary, makeIntent()));
  assert.throws(() => parseGrantLookup(body(amount, "verified"), config, beneficiary));
});
test("preflight uses beneficiary and latest simulation, zero msg.value, checks vault wiring", async () => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const { transaction, afterBlock } = await preflightGrant(mockRpc({}, calls), config, beneficiary, amount);
  assert.equal(afterBlock, 10); assert.equal(transaction.from, beneficiary); assert.equal(transaction.value, "0x0");
  assert.equal(transaction.to, config.vault); assert.equal(transaction.data, encodeGrantSpend(config, amount));
  assert.ok(calls.some((call) => call.method === "eth_call" && (call.params[0] as any).from === beneficiary && call.params[1] === "latest"));
});
for (const [name, rpc] of [
  ["wrong chain", mockRpc({ eth_chainId: "0xa869" })],
  ["RPC failure", mockRpc({ eth_chainId: Error("secret RPC detail") })],
  ["overspend", mockRpc()],
] as const) test(`preflight rejects ${name}`, async () => {
  await assert.rejects(preflightGrant(rpc, config, beneficiary, name === "overspend" ? BigInt(6000) * unit : amount));
});
test("preflight rejects removed merchant, wrong registry and a failing latest simulation", async () => {
  for (const mode of ["merchant", "registry", "simulation"]) {
    const base = mockRpc();
    const rpc: WalletRpc = async (method, params, signal) => {
      const tx = params[0] as { data?: string } | undefined;
      if (method === "eth_call" && ((mode === "merchant" && tx?.data?.startsWith("0x6f790f46")) || (mode === "registry" && tx?.data === "0x6eca5042"))) return mode === "merchant" ? word(BigInt(0)) : addressWord(other);
      if (method === "eth_call" && mode === "simulation" && tx?.data?.startsWith("0xe2f7cbfa")) throw Error("revert");
      return base(method, params, signal);
    };
    await assert.rejects(preflightGrant(rpc, config, beneficiary, amount));
  }
});
test("five thousand → spend one thousand → four thousand, explicit next-spend confirmation", async (t) => {
  const h = harness({ send: async (account, tx) => {
    assert.equal(account, beneficiary); assert.equal(tx.value, "0x0"); assert.ok(h.db.get(grantJournalKey(config, account))?.includes('"phase":"unknown"')); return hash;
  } }); t.after(() => h.controller.dispose());
  await h.controller.bindWallet(beneficiary); await h.controller.spend(amount);
  assert.equal(h.sends(), 1); assert.equal(h.controller.getSnapshot().phase, "confirmed");
  assert.equal(h.controller.getSnapshot().lookup?.balanceWei, (BigInt(4000) * unit).toString());
  await h.controller.spend(amount); assert.equal(h.sends(), 1);
  await h.controller.newSpend(); assert.equal(h.controller.getSnapshot().phase, "idle");
  assert.equal(h.controller.getSnapshot().intent, null); assert.equal(h.db.size, 0);
});
test("user rejection clears only a proven not-sent intent and permits a fresh preflight", async (t) => {
  const h = harness({ send: async () => { throw { outcome: "rejected", code: "SIGNATURE_REJECTED" }; } }); t.after(() => h.controller.dispose());
  await h.controller.bindWallet(beneficiary); await h.controller.spend(amount);
  assert.equal(h.controller.getSnapshot().errorCode, "SIGNATURE_REJECTED"); assert.equal(h.db.size, 0);
  await h.controller.spend(amount); assert.equal(h.sends(), 2);
});
test("ambiguous send is durable, restores after reload and never automatically resends", async (t) => {
  const h = harness({ send: async () => { throw Error("transport lost after wallet send"); } }); t.after(() => h.controller.dispose());
  await h.controller.bindWallet(beneficiary); await h.controller.spend(amount);
  assert.equal(h.controller.getSnapshot().phase, "unknown"); assert.equal(h.db.size, 1);
  const reload = harness({ db: h.db }); t.after(() => reload.controller.dispose()); await reload.controller.bindWallet(beneficiary);
  assert.equal(reload.controller.getSnapshot().phase, "unknown"); await reload.controller.spend(amount); assert.equal(reload.sends(), 0);
  await reload.controller.recoverHash(hash); assert.equal(reload.controller.getSnapshot().phase, "confirmed");
});
test("known pending hash survives RPC loss and resumes verification without sending twice", async (t) => {
  let mode = "pending";
  const h = harness({ fetcher: async (url) => {
    if (!String(url).includes("txHash")) return response(body());
    if (mode === "offline") throw Error("RPC credentials must not leak");
    return response(body(BigInt(4000) * unit, mode === "confirmed" ? "verified" : "pending"));
  } }); t.after(() => h.controller.dispose());
  await h.controller.bindWallet(beneficiary); await h.controller.spend(amount);
  assert.equal(h.controller.getSnapshot().phase, "pending"); mode = "offline"; await h.controller.refresh();
  assert.equal(h.controller.getSnapshot().intent?.hash, hash); assert.equal(h.controller.getSnapshot().stale, true);
  assert.ok(!h.controller.getSnapshot().message?.includes("credentials"));
  mode = "confirmed"; await h.controller.refresh(); assert.equal(h.controller.getSnapshot().phase, "confirmed"); assert.equal(h.sends(), 1);
});
test("a reverted receipt leaves the last verified balance marked stale and permits explicit new spend", async (t) => {
  const h = harness({ fetcher: async (url) => String(url).includes("txHash")
    ? response({ status: "unverified", chainId: 20261, balanceWei: null, error: { code: "TX_REVERTED", retryable: false } }, 422) : response(body()) });
  t.after(() => h.controller.dispose()); await h.controller.bindWallet(beneficiary); await h.controller.spend(amount);
  assert.equal(h.controller.getSnapshot().phase, "reverted"); assert.equal(h.controller.getSnapshot().lookup?.balanceWei, (BigInt(5000) * unit).toString());
  assert.equal(h.controller.getSnapshot().stale, true); assert.equal(h.controller.getSnapshot().intent?.hash, hash);
  await h.controller.newSpend(); assert.equal(h.controller.getSnapshot().phase, "idle"); assert.equal(h.controller.getSnapshot().stale, false);
});
test("wrong receipt event never confirms or releases the pending intent", async (t) => {
  const h = harness({ fetcher: async (url) => { const value = body(amount, String(url).includes("txHash") ? "verified" : "none");
    if (value.transaction) value.transaction.events[0].merchant = other; return response(value); } });
  t.after(() => h.controller.dispose()); await h.controller.bindWallet(beneficiary); await h.controller.spend(amount);
  assert.equal(h.controller.getSnapshot().phase, "pending"); assert.equal(h.controller.getSnapshot().errorCode, "INVALID_GRANT_RESPONSE");
  await h.controller.spend(amount); assert.equal(h.sends(), 1);
});
test("storage unavailable blocks wallet send, corrupt journal blocks unsafe recovery", async (t) => {
  const h = harness({ store: { getItem: () => null, setItem: () => { throw Error("quota"); }, removeItem: () => {} } });
  t.after(() => h.controller.dispose()); await h.controller.bindWallet(beneficiary); await h.controller.spend(amount); assert.equal(h.sends(), 0);
  const db = new Map([[grantJournalKey(config, beneficiary), '{"phase":"unknown"}']]);
  const corrupt = harness({ db }); t.after(() => corrupt.controller.dispose()); await corrupt.controller.bindWallet(beneficiary);
  assert.equal(corrupt.controller.getSnapshot().storageBlocked, true); await corrupt.controller.spend(amount); assert.equal(corrupt.sends(), 0);
});
test("wallet/chain change during preflight does not open a signing request", async (t) => {
  let h: ReturnType<typeof harness>; const base = mockRpc();
  h = harness({ rpc: async (method, params, signal) => { if (method === "eth_chainId") h.walletState.address = other; return base(method, params, signal); } });
  t.after(() => h.controller.dispose()); await h.controller.bindWallet(beneficiary); await h.controller.spend(amount);
  assert.equal(h.sends(), 0); assert.equal(h.controller.getSnapshot().errorCode, "WALLET_CHANGED");
});
test("account switch while Core is open preserves hash for its original beneficiary without leaking into new account", async (t) => {
  let finish!: (hash: string) => void;
  const h = harness({ send: () => new Promise((resolve) => { finish = resolve; }) }); t.after(() => h.controller.dispose());
  await h.controller.bindWallet(beneficiary); const operation = h.controller.spend(amount);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  h.walletState.address = other; await h.controller.bindWallet(other); finish(hash); await operation;
  assert.equal(h.controller.getSnapshot().beneficiary, other); assert.equal(h.controller.getSnapshot().intent, null);
  assert.equal(JSON.parse(h.db.get(grantJournalKey(config, beneficiary))!).hash, hash);
  h.walletState.address = beneficiary; await h.controller.bindWallet(beneficiary); assert.equal(h.controller.getSnapshot().phase, "confirmed");
});
test("two tabs serialize claim and send through the lock and shared durable intent", async (t) => {
  let locked = false, release!: (value: string) => void;
  const lock = async (_name: string, run: () => Promise<void>) => { if (locked) throw new GrantUiError("SPEND_IN_PROGRESS"); locked = true; try { await run(); } finally { locked = false; } };
  const first = harness({ lock, send: () => new Promise((resolve) => { release = resolve; }) });
  const second = harness({ lock, db: first.db }); t.after(() => { first.controller.dispose(); second.controller.dispose(); });
  await first.controller.bindWallet(beneficiary); await second.controller.bindWallet(beneficiary);
  const operation = first.controller.spend(amount); while (!release) await new Promise((resolve) => setImmediate(resolve));
  await second.controller.spend(amount); assert.equal(second.sends(), 0); assert.equal(second.controller.getSnapshot().errorCode, "SPEND_IN_PROGRESS");
  release(hash); await operation; await second.controller.spend(amount); assert.equal(second.sends(), 0);
});
test("HTTP unverified response and oversized/malformed payload never become a balance", async () => {
  await assert.rejects(lookupGrant(async () => response({ status: "unverified", chainId: 20261, balanceWei: null, error: { code: "RPC_UNAVAILABLE", retryable: true } }, 503), config, beneficiary), /RPC_UNAVAILABLE/);
  await assert.rejects(lookupGrant(async () => new Response("x".repeat(256 * 1024 + 1)), config, beneficiary));
  await assert.rejects(lookupGrant(async () => response({ ...body(), balanceWei: null }), config, beneficiary));
});
test("a recovered unrelated reverted hash cannot unlock an ambiguous original spend", async (t) => {
  let wrongHash = true;
  const h = harness({ send: async () => { throw Error("ambiguous send"); }, fetcher: async (url) => {
    if (!String(url).includes("txHash")) return response(body());
    return wrongHash ? response({ status: "unverified", chainId: 20261, balanceWei: null, error: { code: "TX_REVERTED", retryable: false } }, 422)
      : response(body(BigInt(4000) * unit, "verified"));
  } }); t.after(() => h.controller.dispose()); await h.controller.bindWallet(beneficiary); await h.controller.spend(amount);
  await h.controller.recoverHash(blockHash); assert.equal(h.controller.getSnapshot().phase, "pending");
  assert.equal(h.controller.getSnapshot().errorCode, "RECOVERY_HASH_REVERTED"); await h.controller.newSpend(); await h.controller.spend(amount); assert.equal(h.sends(), 1);
  wrongHash = false; await h.controller.recoverHash(hash); assert.equal(h.controller.getSnapshot().phase, "confirmed");
});
test("a late confirmation from another tab cannot overwrite a newer spend journal", async (t) => {
  const old = makeIntent(), newer = makeIntent({ hash: blockHash });
  const db = new Map([[grantJournalKey(config, beneficiary), JSON.stringify(old)]]);
  const h = harness({ db, fetcher: async () => {
    db.set(grantJournalKey(config, beneficiary), JSON.stringify(newer));
    return response(body(BigInt(4000) * unit, "verified"));
  } }); t.after(() => h.controller.dispose()); await h.controller.bindWallet(beneficiary);
  assert.equal(JSON.parse(db.get(grantJournalKey(config, beneficiary))!).id, newer.id);
  assert.notEqual(h.controller.getSnapshot().phase, "confirmed");
});
test("a hash remains visible if storage fails after Core returns it", async (t) => {
  const db = new Map<string, string>(); let writes = 0;
  const h = harness({ db, store: { getItem: (key) => db.get(key) ?? null, setItem: (key, value) => { if (++writes > 1) throw Error("quota"); db.set(key, value); }, removeItem: (key) => { db.delete(key); } },
    fetcher: async (url) => response(body(amount, String(url).includes("txHash") ? "pending" : "none")) });
  t.after(() => h.controller.dispose()); await h.controller.bindWallet(beneficiary); await h.controller.spend(amount);
  assert.equal(h.controller.getSnapshot().intent?.hash, hash); assert.equal(h.controller.getSnapshot().storageBlocked, true);
  assert.equal(JSON.parse(db.get(grantJournalKey(config, beneficiary))!).phase, "unknown"); await h.controller.spend(amount); assert.equal(h.sends(), 1);
});
test("a canonical block change after simulation prevents sending", async (t) => {
  const base = mockRpc();
  const h = harness({ rpc: async (method, params, signal) => method === "eth_getBlockByNumber" && params[0] !== "latest"
    ? { number: "0xa", hash } : base(method, params, signal) }); t.after(() => h.controller.dispose());
  await h.controller.bindWallet(beneficiary); await h.controller.spend(amount); assert.equal(h.sends(), 0); assert.equal(h.controller.getSnapshot().errorCode, "CHAIN_CHANGED");
});
test("without a browser transaction lock, reads work and sends fail closed", async (t) => {
  const h = harness({ lock: async () => { throw new GrantUiError("LOCK_UNAVAILABLE"); } }); t.after(() => h.controller.dispose());
  await h.controller.bindWallet(beneficiary); assert.ok(h.controller.getSnapshot().lookup); await h.controller.spend(amount);
  assert.equal(h.sends(), 0); assert.equal(h.controller.getSnapshot().errorCode, "LOCK_UNAVAILABLE");
});
