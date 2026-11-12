import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { InvoiceStatusController, parseInvoiceLookup, POS_ACTIVE_INVOICE_KEY } from "../lib/invoice-status.ts";
const fixture = JSON.parse(readFileSync(new URL("../../docs/fixtures/invoice-v1.json", import.meta.url), "utf8"));
const envelope = fixture.envelope;
const hash = `0x${"ab".repeat(32)}`;
function pending(status = "pending", transaction: unknown = null) {
  return { invoiceId: envelope.invoice.invoiceId, envelope, status, receipt: null, transaction, updatedAt: 100 };
}
function paid() {
  const original = BigInt(envelope.invoice.amount), discount = original / BigInt(10);
  return { ...pending("paid", { txHash: hash, status: "confirmed" }), updatedAt: 101,
    receipt: { invoiceId: envelope.invoice.invoiceId, invoiceCode: envelope.meta.invoiceCode, chainId: 20261,
      contractAddress: envelope.domain.verifyingContract, txHash: hash, blockNumber: 10, logIndex: 0,
      payer: `0x${"12".repeat(20)}`, merchant: envelope.invoice.merchant, category: envelope.invoice.category,
      originalAmount: original.toString(), discountAmount: discount.toString(), paidAmount: (original - discount).toString(),
      tier: 1, gasUsed: "21000", effectiveGasPrice: "100", verifiedAt: 101 } };
}
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function harness(fetcher: typeof fetch, initial = new Map<string, string>()) {
  const tasks: Array<{ fn: () => void; delay: number }> = [];
  const storage = { getItem: (key: string) => initial.get(key) ?? null, setItem: (key: string, value: string) => { initial.set(key, value); } };
  const controller = new InvoiceStatusController({ fetcher, storage,
    schedule: (fn, delay) => { const task = { fn, delay }; tasks.push(task); return task; },
    cancel: (task) => { const i = tasks.indexOf(task as typeof tasks[number]); if (i >= 0) tasks.splice(i, 1); } });
  return { controller, tasks, storage, initial };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
test("paid lookup validates invoice/deployment/transaction and all monetary relationships", () => {
  assert.equal(parseInvoiceLookup(paid(), envelope.invoice.invoiceId).status, "paid");
  for (const field of ["invoiceId", "invoiceCode", "contractAddress", "txHash", "merchant", "category", "paidAmount", "originalAmount", "discountAmount", "chainId", "tier", "gasUsed", "blockNumber"]) {
    const value = paid() as any;
    value.receipt[field] = typeof value.receipt[field] === "number" ? -1 : "wrong";
    assert.throws(() => parseInvoiceLookup(value, envelope.invoice.invoiceId), Error, field);
  }
  assert.throws(() => parseInvoiceLookup({ ...paid(), receipt: null }, envelope.invoice.invoiceId));
  assert.throws(() => parseInvoiceLookup({ ...pending(), transaction: { txHash: hash, status: "confirmed" } }, envelope.invoice.invoiceId));
  const changed = structuredClone(envelope); changed.invoice.amount = "42";
  assert.throws(() => parseInvoiceLookup(paid(), envelope.invoice.invoiceId, changed));
});
test("polls sequentially, obeys Retry-After, retains hash during RPC loss and accepts late paid", async () => {
  let calls = 0;
  const tx = { txHash: hash, status: "unverified" };
  const error = { code: "RPC_UNAVAILABLE", message: "RPC mất", nextStep: "Giữ hash", retryable: true };
  const bodies = [response(pending("expired", tx)), response({ ...pending("rpc-error", tx), lastKnownStatus: "expired", error }, 503, { "Retry-After": "16" }), response(paid())];
  const { controller, tasks } = harness(async () => { calls++; return bodies.shift()!; });
  await controller.watch(envelope.invoice.invoiceId);
  assert.equal(tasks[0].delay, 2000);
  tasks.shift()!.fn(); await tick();
  assert.equal(controller.getSnapshot().lookup?.transaction?.txHash, hash);
  assert.equal(tasks[0].delay, 16000);
  tasks.shift()!.fn(); await tick();
  assert.equal(controller.getSnapshot().lookup?.status, "paid");
  assert.equal(tasks.length, 0); assert.equal(calls, 3); controller.dispose();
});
test("reverted/mismatched receipts and malformed paid never produce success", async () => {
  for (const status of ["reverted", "event-mismatch"]) {
    const body = { ...pending("pending", { txHash: hash, status }), error: { code: status === "reverted" ? "TX_REVERTED" : "RECEIPT_EVENT_MISMATCH", message: "Chưa trả", nextStep: "Tra cứu lại", retryable: false } };
    const { controller } = harness(async () => response(body, 422));
    await controller.watch(envelope.invoice.invoiceId);
    assert.equal(controller.getSnapshot().lookup?.status, "pending");
    assert.equal(controller.getSnapshot().announcement, null); controller.dispose();
  }
  const { controller } = harness(async () => response({ ...paid(), receipt: null }));
  await controller.watch(envelope.invoice.invoiceId);
  assert.equal(controller.getSnapshot().lookup, null); assert.ok(controller.getSnapshot().message);
  controller.dispose();
});
test("reload re-GETs stored invoice and announces one time per verified event", async () => {
  const db = new Map<string, string>();
  const first = harness(async () => response(paid()), db);
  await first.controller.watch(envelope.invoice.invoiceId);
  assert.ok(first.controller.getSnapshot().announcement);
  assert.equal(db.get(POS_ACTIVE_INVOICE_KEY), envelope.invoice.invoiceId);
  first.controller.dispose();
  const restored = harness(async (url, init) => {
    assert.match(String(url), new RegExp(envelope.invoice.invoiceId)); assert.equal(init?.method, undefined);
    return response(paid());
  }, db);
  await restored.controller.restore();
  assert.equal(restored.controller.getSnapshot().lookup?.status, "paid");
  assert.equal(restored.controller.getSnapshot().announcement, null); restored.controller.dispose();
});
test("changing invoice discards a late response and dispose aborts active request", async () => {
  let release!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  const h = harness(async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>((resolve) => { release = resolve; }); });
  const first = h.controller.watch(envelope.invoice.invoiceId);
  h.controller.dispose(); assert.equal(signal?.aborted, true);
  release(response(paid())); await first;
  assert.equal(h.controller.getSnapshot().lookup, null); assert.equal(h.tasks.length, 0);
});
test("manual refresh never overlaps an active lookup; hash hints use existing GET", async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  const h = harness(async () => { calls++; return new Promise<Response>((resolve) => { release = resolve; }); });
  const first = h.controller.watch(envelope.invoice.invoiceId);
  await h.controller.refresh(hash); assert.equal(calls, 1);
  release(response(pending())); await first;
  assert.equal(h.controller.getSnapshot().pendingHash, hash);
  h.controller.dispose();
  const c = harness(async (url) => { assert.match(String(url), new RegExp(`txHash=${hash}`)); return response(pending()); });
  await c.controller.watch(envelope.invoice.invoiceId, undefined, hash); c.controller.dispose();
});
test("a late previous invoice cannot overwrite the current invoice", async () => {
  let release!: (response: Response) => void;
  let calls = 0;
  const h = harness(async () => { calls++; return calls === 1 ? new Promise<Response>((resolve) => { release = resolve; })
    : response({ ...pending(), invoiceId: hash, envelope: { ...envelope, invoice: { ...envelope.invoice, invoiceId: hash } } }); });
  const old = h.controller.watch(envelope.invoice.invoiceId);
  await h.controller.watch(hash);
  release(response(paid())); await old;
  assert.equal(h.controller.getSnapshot().invoiceId, hash);
  assert.equal(h.controller.getSnapshot().lookup?.status, "pending");
  assert.equal(h.controller.getSnapshot().announcement, null); h.controller.dispose();
});
test("a hash supplied during a transport outage survives reload before backend acknowledges it", async () => {
  const db = new Map<string, string>();
  const h = harness(async () => { throw Error("offline"); }, db);
  await h.controller.watch(envelope.invoice.invoiceId, envelope, hash);
  assert.equal(h.controller.getSnapshot().pendingHash, hash); h.controller.dispose();
  const restored = harness(async (url) => { assert.match(String(url), new RegExp(`txHash=${hash}`));
    return response(pending("expired", { txHash: hash, status: "unverified" })); }, db);
  await restored.controller.restore(); assert.equal(restored.controller.getSnapshot().pendingHash, hash);
  restored.controller.dispose();
});
test("storage denial degrades visibly, network errors back off without losing prior invoice", async () => {
  const tasks: number[] = [];
  const c = new InvoiceStatusController({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } },
    fetcher: async () => { throw Error("network"); }, schedule: (_fn, delay) => { tasks.push(delay); return 1; }, cancel() {} });
  await c.watch(envelope.invoice.invoiceId, envelope);
  assert.ok(c.getSnapshot().storageWarning); assert.equal(c.getSnapshot().invoiceId, envelope.invoice.invoiceId);
  assert.equal(tasks[0], 2000); await c.refresh(); assert.equal(tasks[1], 4000);
  c.dispose();
});
test("default browser fetch keeps its global receiver", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function(this: unknown) { assert.equal(this, globalThis); return response(pending()); };
  const controller = new InvoiceStatusController({ schedule: () => 1, cancel() {} });
  try { await controller.watch(envelope.invoice.invoiceId); assert.equal(controller.getSnapshot().lookup?.status, "pending"); }
  finally { controller.dispose(); globalThis.fetch = original; }
});
