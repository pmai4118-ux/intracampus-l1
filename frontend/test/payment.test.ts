import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PaymentController, paymentStorageKey, restorePaymentPreview, type InvoicePreview } from "../lib/payment.ts";
import { encodePayInvoiceSimulation, InvoicePreviewError } from "../lib/invoice.ts";
import { WalletController, WalletTransactionError, type WalletProvider, type WalletSnapshot, type WalletTransaction } from "../lib/wallet.ts";

const envelope = JSON.parse(readFileSync(new URL("../../docs/fixtures/invoice-v1.json", import.meta.url), "utf8")).envelope;
const A = `0x${"12".repeat(20)}`, B = `0x${"34".repeat(20)}`, hash = `0x${"ab".repeat(32)}`;
const amount = BigInt(envelope.invoice.amount);
const preview = (tier: 0 | 1 = 1): InvoicePreview => ({ envelope: structuredClone(envelope), quote: { tier,
  originalAmount: amount, discountAmount: tier ? amount / BigInt(10) : BigInt(0),
  paidAmount: tier ? amount - amount / BigInt(10) : amount, blockNumber: "0x10", blockTimestamp: BigInt(100) } });
function ready(address = A): WalletSnapshot {
  return { status: "ready", address, accounts: [address], chainId: BigInt(20261), balanceWei: amount * BigInt(2),
    card: { status: "valid", tier: 1, tokenId: BigInt(1), expiresAt: BigInt(1000) }, blockTimestamp: BigInt(100), canProceed: true, message: null };
}
function pending(status = "pending", transaction: unknown = null) {
  return { invoiceId: envelope.invoice.invoiceId, envelope, status, receipt: null, transaction, updatedAt: 100 };
}
function paid(payer = A, txHash = hash, tier: 0 | 1 = 1) {
  const q = preview(tier).quote;
  return { ...pending("paid", { txHash, status: "confirmed" }), updatedAt: 101,
    receipt: { invoiceId: envelope.invoice.invoiceId, invoiceCode: envelope.meta.invoiceCode, chainId: 20261,
      contractAddress: envelope.domain.verifyingContract, txHash, blockNumber: 10, logIndex: 0,
      payer, merchant: envelope.invoice.merchant, category: envelope.invoice.category,
      originalAmount: amount.toString(), discountAmount: q.discountAmount.toString(), paidAmount: q.paidAmount.toString(),
      tier, gasUsed: "21000", effectiveGasPrice: "100", verifiedAt: 101 } };
}
function storage(map = new Map<string, string>()) {
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function harness(options: { db?: ReturnType<typeof storage>; tier?: 0 | 1; account?: string } = {}) {
  const db = options.db ?? storage(); let snapshot = ready(options.account);
  let fresh = preview(options.tier); let sends = 0; let preflights = 0;
  let send: (account: string, tx: WalletTransaction) => Promise<string> = async () => hash;
  let fetcher: typeof fetch = async () => response(pending("pending", { txHash: hash, status: "unverified" }));
  let preflight: () => Promise<InvoicePreview> = async () => fresh;
  const c = new PaymentController({ preview: preview(options.tier), account: options.account ?? A, storage: db,
    wallet: { getSnapshot: () => snapshot, sendTransaction: async (account, tx) => { sends++; return send(account, tx); } },
    preflight: async () => { preflights++; return preflight(); }, fetcher: (...args) => fetcher(...args) });
  return { c, db, sends: () => sends, preflights: () => preflights,
    setWallet: (s: WalletSnapshot) => { snapshot = s; }, setFresh: (p: InvoicePreview) => { fresh = p; },
    setSend: (fn: typeof send) => { send = fn; }, setFetch: (fn: typeof fetcher) => { fetcher = fn; },
    setPreflight: (fn: typeof preflight) => { preflight = fn; } };
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

for (const tier of [0, 1] as const) test(`tier ${tier}: fresh preflight sends correct student/value/calldata and verifies B02 receipt`, async () => {
  const h = harness({ tier });
  h.setSend(async (account, tx) => {
    assert.equal(account, A); assert.equal(tx.to, envelope.domain.verifyingContract);
    assert.equal(tx.data, encodePayInvoiceSimulation(envelope)); assert.equal(tx.value, `0x${preview(tier).quote.paidAmount.toString(16)}`);
    assert.ok(h.db.getItem(paymentStorageKey(envelope)), "intent persisted before wallet request"); return hash;
  });
  h.setFetch(async (url) => { assert.match(String(url), new RegExp(`txHash=${hash}`)); return response(paid(A, hash, tier)); });
  await h.c.pay(); assert.equal(h.preflights(), 1); assert.equal(h.sends(), 1); assert.equal(h.c.getSnapshot().status, "paid");
  assert.equal(h.c.getSnapshot().receipt?.payer, A); await h.c.pay(); assert.equal(h.sends(), 1);
});
test("changed quote is displayed and requires a second explicit click with another fresh preflight", async () => {
  const h = harness(); h.setFresh(preview(0));
  await h.c.pay(); assert.equal(h.sends(), 0); assert.equal(h.c.getSnapshot().status, "quote-changed");
  assert.equal(h.c.getSnapshot().preview.quote.paidAmount, amount);
  await h.c.pay(); assert.equal(h.sends(), 1); assert.equal(h.preflights(), 2);
});
test("expired, already-paid, invalid-signature and failed simulations never open Core", async () => {
  for (const code of ["INVOICE_EXPIRED", "INVOICE_ALREADY_PAID", "INVALID_SIGNATURE", "PAYMENT_SIMULATION_FAILED"]) {
    const h = harness(); h.setPreflight(async () => { throw new InvoicePreviewError(code); });
    await h.c.pay(); assert.equal(h.sends(), 0); assert.equal(h.db.getItem(paymentStorageKey(envelope)), null);
  }
});
test("switching account or chain while preflight waits prevents signing", async () => {
  for (const change of [ready(B), { ...ready(), chainId: BigInt(43113) }]) {
    const h = harness(), wait = deferred<InvoicePreview>(); h.setPreflight(() => wait.promise);
    const run = h.c.pay(); h.setWallet(change); wait.resolve(preview()); await run;
    assert.equal(h.sends(), 0); assert.equal(h.db.getItem(paymentStorageKey(envelope)), null);
  }
});
test("double click and remounted panel cannot overlap the same invoice", async () => {
  const db = storage(), first = harness({ db }), second = harness({ db }), wait = deferred<InvoicePreview>();
  first.setPreflight(() => wait.promise); const run = first.c.pay();
  await first.c.pay(); await second.c.pay(); assert.equal(second.preflights(), 0);
  wait.resolve(preview()); await run; await second.c.pay();
  assert.equal(first.sends(), 1); assert.equal(second.sends(), 0);
});
test("rejection and proven pre-send failure clear intent and allow an explicit new attempt", async () => {
  for (const outcome of ["rejected", "not-sent"] as const) {
    const h = harness(); h.setSend(async () => { throw new WalletTransactionError("SIGNATURE_REJECTED", outcome); });
    await h.c.pay(); assert.equal(h.c.getSnapshot().canPay, true); assert.equal(h.db.getItem(paymentStorageKey(envelope)), null);
    h.setSend(async () => hash); await h.c.pay(); assert.equal(h.sends(), 2);
  }
});
test("transport failure after opening Core is unknown and survives reload without a hash", async () => {
  const db = storage(), h = harness({ db }); h.setSend(async () => { throw new Error("secret RPC failure"); });
  await h.c.pay(); assert.equal(h.c.getSnapshot().status, "unknown");
  assert.doesNotMatch(h.c.getSnapshot().message!, /secret/); await h.c.pay(); assert.equal(h.sends(), 1);
  const restoredPreview = restorePaymentPreview(db, A); assert.ok(restoredPreview);
  const restored = harness({ db }); assert.equal(restored.c.getSnapshot().status, "unknown");
  await restored.c.pay(); assert.equal(restored.sends(), 0);
  restored.setFetch(async () => response(paid())); await restored.c.refresh(hash);
  assert.equal(restored.c.getSnapshot().status, "paid");
});
test("a pending hash remains locked after expiry and RPC loss, then accepts a late verified receipt", async () => {
  const h = harness(); await h.c.pay();
  h.setFetch(async () => response({ ...pending("rpc-error", { txHash: hash, status: "unverified" }), lastKnownStatus: "expired",
    error: { code: "RPC_UNAVAILABLE", message: "Mất RPC", nextStep: "Giữ hash", retryable: true } }, 503));
  await h.c.refresh(); assert.equal(h.c.getSnapshot().txHash, hash); assert.equal(h.c.getSnapshot().canPay, false);
  h.setFetch(async () => response(pending("expired", { txHash: hash, status: "unverified" })));
  await h.c.refresh(); await h.c.pay(); assert.equal(h.sends(), 1);
  h.setFetch(async () => response(paid())); await h.c.refresh(); assert.equal(h.c.getSnapshot().status, "paid");
});
test("returned hash is persisted after component disposal during the wallet popup", async () => {
  const db = storage(), h = harness({ db }), wait = deferred<string>(); h.setSend(() => wait.promise);
  const run = h.c.pay(); while (h.sends() === 0) await new Promise((done) => setImmediate(done));
  h.c.dispose(); wait.resolve(hash); await run;
  const restored = harness({ db }); assert.equal(restored.c.getSnapshot().txHash, hash);
  restored.setFetch(async () => response(paid())); await restored.c.refresh(); assert.equal(restored.c.getSnapshot().status, "paid");
});
test("receipt with wrong payer/hash or a different paid amount never claims this student's success", async () => {
  for (const body of [paid(B), paid(A, `0x${"cd".repeat(32)}`), paid(A, hash, 0)]) {
    const h = harness(); h.setFetch(async () => response(body)); await h.c.pay();
    assert.equal(h.c.getSnapshot().status, "blocked"); assert.equal(h.c.getSnapshot().receipt, null); assert.equal(h.c.getSnapshot().canPay, false);
  }
});
test("another wallet cannot claim the stored payer's receipt or send again", async () => {
  const db = storage(), first = harness({ db }); await first.c.pay();
  const other = harness({ db, account: B }); other.setFetch(async () => response(paid()));
  await other.c.refresh(); await other.c.pay(); assert.equal(other.sends(), 0); assert.equal(other.c.getSnapshot().status, "blocked");
  assert.equal(other.c.getSnapshot().receipt, null); assert.equal(restorePaymentPreview(db, B), null);
});
test("reverted and event-mismatch transactions keep the journal and never show success", async () => {
  for (const status of ["reverted", "event-mismatch"]) {
    const h = harness(); h.setFetch(async () => response({ ...pending("pending", { txHash: hash, status }),
      error: { code: status === "reverted" ? "TX_REVERTED" : "RECEIPT_EVENT_MISMATCH", message: "Chưa thanh toán", nextStep: "Đối chiếu", retryable: false } }, 422));
    await h.c.pay(); assert.equal(h.c.getSnapshot().receipt, null); assert.equal(h.c.getSnapshot().canPay, false);
    assert.ok(h.db.getItem(paymentStorageKey(envelope)));
  }
});
test("unavailable/corrupt storage cannot open a wallet request", async () => {
  const corrupt = storage(); corrupt.setItem(paymentStorageKey(envelope), "broken");
  const h = harness({ db: corrupt }); await h.c.pay(); assert.equal(h.sends(), 0); assert.equal(h.c.getSnapshot().status, "blocked");
  const db = storage(); db.setItem = () => { throw Error("full"); };
  const full = harness({ db }); await full.c.pay(); assert.equal(full.sends(), 0);
});
test("browser lock denial never opens the wallet", async () => {
  let sends = 0;
  const c = new PaymentController({ preview: preview(), account: A, storage: storage(), wallet: { getSnapshot: () => ready(),
    sendTransaction: async () => { sends++; return hash; } }, preflight: async () => preview(),
    exclusive: async () => { throw Error("locked"); } });
  await c.pay(); assert.equal(sends, 0);
});
test("an HTTP422 body cannot masquerade as a verified paid response", async () => {
  const h = harness(); h.setFetch(async () => response(paid(), 422)); await h.c.pay();
  assert.equal(h.c.getSnapshot().receipt, null); assert.equal(h.c.getSnapshot().canPay, false);
});

class Provider implements WalletProvider {
  address = A; chain = "0x4f25"; calls: { method: string; params?: unknown[] }[] = [];
  send: () => Promise<unknown> = async () => hash;
  async request(call: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push(call); if (call.method === "eth_accounts") return [this.address];
    if (call.method === "eth_chainId") return this.chain;
    if (call.method === "eth_sendTransaction") return this.send(); throw Error("Unexpected method");
  }
  on() {} removeListener() {}
}
async function wallet() {
  const provider = new Provider();
  const c = new WalletController({ provider, config: { rpcUrl: "https://rpc.example", sbtAddress: B }, rpc: async (method, params) => {
    if (method === "eth_chainId") return "0x4f25";
    if (method === "eth_getBlockByNumber") return { number: "0x1", timestamp: "0x1" };
    if (method === "eth_getBalance") return "0x100";
    if (method === "eth_call") return (params[0] as { data: string }).data.startsWith("0xc8f74bb8") ? `0x${"0".repeat(64)}` : `0x${"0".repeat(128)}`;
    throw Error("Unexpected RPC");
  } }); await c.start(); assert.equal(c.getSnapshot().canProceed, true); return { provider, c };
}
const tx = { to: B, data: "0x12345678", value: "0x0" };
test("wallet transport uses current student as from and explicit chain20261", async () => {
  const { provider, c } = await wallet(); assert.equal(await c.sendTransaction(A, tx), hash);
  assert.deepEqual(provider.calls.at(-1), { method: "eth_sendTransaction", params: [{ from: A, ...tx, chainId: "0x4f25" }] }); c.dispose();
});
test("background refresh preserves identity while immediately clearing data and payment readiness", async () => {
  const { c } = await wallet(); const read = c.refresh();
  assert.equal(c.getSnapshot().address, A); assert.equal(c.getSnapshot().chainId, BigInt(20261));
  assert.equal(c.getSnapshot().balanceWei, null); assert.equal(c.getSnapshot().card.tier, null); assert.equal(c.getSnapshot().canProceed, false);
  await read; assert.equal(c.getSnapshot().canProceed, true); c.dispose();
});
test("wallet detects account/chain changes even without provider events", async () => {
  for (const field of ["address", "chain"] as const) {
    const { provider, c } = await wallet(); if (field === "address") provider.address = B; else provider.chain = "0xa86a";
    await assert.rejects(c.sendTransaction(A, tx), (error: unknown) => error instanceof WalletTransactionError && error.outcome === "not-sent");
    assert.ok(!provider.calls.some((call) => call.method === "eth_sendTransaction")); c.dispose();
  }
});
test("wallet preserves a broadcast hash after disconnect during popup and rejects overlapping send", async () => {
  const { provider, c } = await wallet(), wait = deferred<unknown>(); provider.send = () => wait.promise;
  const run = c.sendTransaction(A, tx); while (!provider.calls.some((call) => call.method === "eth_sendTransaction")) await new Promise((done) => setImmediate(done));
  await assert.rejects(c.sendTransaction(A, tx), (error: unknown) => error instanceof WalletTransactionError && error.code === "WALLET_REQUEST_PENDING");
  c.disconnect(); wait.resolve(hash); assert.equal(await run, hash); c.dispose();
});
test("wallet distinguishes explicit user rejection from uncertain provider failures", async () => {
  for (const code of [4001, -32000]) {
    const { provider, c } = await wallet(); provider.send = async () => { throw { code, message: "secret" }; };
    await assert.rejects(c.sendTransaction(A, tx), (error: unknown) => error instanceof WalletTransactionError
      && error.outcome === (code === 4001 ? "rejected" : "unknown") && !error.message.includes("secret")); c.dispose();
  }
});
test("invalid wallet hash is an uncertain send, never a proven rejection", async () => {
  const { provider, c } = await wallet(); provider.send = async () => "0x0";
  await assert.rejects(c.sendTransaction(A, tx), (error: unknown) => error instanceof WalletTransactionError && error.outcome === "unknown"); c.dispose();
});
