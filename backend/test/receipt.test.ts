import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SqliteInvoiceRepository } from "../src/modules/invoices/invoices.repository.ts";
import { ReceiptService } from "../src/modules/invoices/receipt.service.ts";
import { verifyReceiptLog } from "../src/modules/invoices/receipt.verifier.ts";
import { deployment, envelope, FakeRpc, fixture, invoiceId, otherHash, receipt, txHash } from "./invoices.helpers.ts";

function setup(t: TestContext, options: { blockRange?: number; maxScanRanges?: number } = {}) {
  const repository = new SqliteInvoiceRepository(":memory:");
  t.after(() => repository.close());
  repository.create(envelope);
  const rpc = new FakeRpc();
  let clock = envelope.meta.issuedAt * 1000;
  const events: Record<string, unknown>[] = [];
  const service = new ReceiptService({ repository, rpc, deployment, now: () => clock, log: (e) => events.push(e), ...options });
  return { repository, rpc, service, events, advance: (ms: number) => { clock += ms; } };
}

test("repository validates the B01 envelope boundary and raw fixture stays reproducible", (t) => {
  const { repository } = setup(t);
  const raw = JSON.parse(readFileSync(new URL("../../docs/fixtures/b02-receipt-fixture.json", import.meta.url), "utf8"));
  assert.deepEqual(raw.envelope, envelope); assert.deepEqual(raw.rpcReceipt, receipt());
  for (const invoice of [
    { ...envelope.invoice, amount: "1.5" },
    { ...envelope.invoice, amount: (2n ** 256n).toString() },
    { ...envelope.invoice, invoiceId: otherHash },
    { ...envelope.invoice, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => repository.create({ ...envelope, invoice }));
  assert.deepEqual(repository.get(invoiceId)?.envelope, envelope);
});

for (const row of fixture.receiptCases) {
  test(`real B02 decoder: ${row.name}`, () => {
    const r = receipt(row);
    const verified = verifyReceiptLog(envelope, r, r.logs[0], 1);
    assert.equal(verified !== null, row.accepted);
    if (verified) {
      assert.equal(verified.tier, row.tier);
      assert.equal(verified.paidAmount, row.paidAmount);
      assert.equal(typeof verified.paidAmount, "string");
    }
  });
}

test("strict decoder rejects spoofed or malformed event and receipt metadata", () => {
  const r = receipt(), log = r.logs[0]!;
  const badTopics = (index: number, value: string) => ({ ...log, topics: log.topics.map((v, i) => i === index ? value : v) });
  const cases = [
    { ...log, address: "0x0000000000000000000000000000000000099999" },
    badTopics(0, otherHash), badTopics(1, otherHash), badTopics(3, otherHash),
    badTopics(2, `0x01${"0".repeat(62)}`), { ...log, topics: log.topics.slice(0, 3) },
    { ...log, data: "0x" }, { ...log, data: log.data + "00" },
    { ...log, data: otherHash + log.data.slice(66) },
    { ...log, data: log.data.slice(0, -64) + "1" + "0".repeat(63) },
    { ...log, removed: true }, { ...log, transactionHash: otherHash },
    { ...log, blockHash: otherHash }, { ...log, blockNumber: "0x81" }, { ...log, logIndex: "0x01" },
  ];
  for (const invalid of cases) assert.equal(verifyReceiptLog(envelope, r, invalid, 1), null);
  assert.equal(verifyReceiptLog(envelope, { ...r, status: "0x0" }, log, 1), null);
});

test("decoder preserves uint256 values and rounds discounts down at one wei", () => {
  for (const original of [11n, 2n ** 256n - 1n]) {
    const amount = original.toString(), discount = original / 10n;
    const r = receipt({ originalAmount: amount, discountAmount: discount.toString(), paidAmount: (original - discount).toString(), tier: 1 });
    const verified = verifyReceiptLog({ ...envelope, invoice: { ...envelope.invoice, amount } }, r, r.logs[0], 1);
    assert.equal(verified?.originalAmount, amount);
    assert.equal(verified?.discountAmount, discount.toString());
  }
});

test("discovery without txHash confirms once; repeated and concurrent polls return the stored receipt", async (t) => {
  const { rpc, service, events } = setup(t);
  rpc.settle();
  const responses = await Promise.all(Array.from({ length: 8 }, () => service.lookup(invoiceId)));
  for (const r of responses) { assert.equal(r.httpStatus, 200); assert.equal(r.body.status, "paid"); }
  assert.equal(events.filter((e) => e.event === "invoice_paid").length, 1);
  const count = rpc.calls.length;
  rpc.available = false;
  const cached = await service.lookup(invoiceId, otherHash);
  assert.deepEqual(cached, responses[0]);
  assert.equal(rpc.calls.length, count);
  const query = rpc.calls.find((c) => c.method === "eth_getLogs")!;
  assert.deepEqual((query.params[0] as { topics: string[] }).topics.slice(1), [invoiceId]);
});

test("a stale nonpaid snapshot cannot overwrite a committed paid receipt", async (t) => {
  const { rpc, service, repository } = setup(t);
  const stale = repository.get(invoiceId)!;
  rpc.settle(); await service.lookup(invoiceId);
  assert(repository.save(invoiceId, stale).receipt);
  assert.throws(() => repository.create(envelope));
});

test("a canonical payment wins a wrong hinted txHash", async (t) => {
  const { rpc, service } = setup(t); rpc.settle();
  const result = await service.lookup(invoiceId, otherHash);
  assert.equal(result.body.status, "paid");
  assert.equal(result.body.transaction?.txHash, txHash);
});

test("chain timestamp, including the exact expiry second, controls lifecycle", async (t) => {
  const { rpc, service, advance } = setup(t);
  advance(86400 * 1000);
  assert.equal((await service.lookup(invoiceId)).body.status, "pending");
  rpc.timestamp++;
  const result = await service.lookup(invoiceId);
  assert.equal(result.httpStatus, 200); assert.equal(result.body.status, "expired");
});

for (const expired of [false, true]) {
  test(`receipt-null remains unverified ${expired ? "after" : "before"} expiry`, async (t) => {
    const { rpc, service } = setup(t);
    rpc.timestamp += expired ? 1 : 0;
    const result = await service.lookup(invoiceId, txHash);
    assert.equal(result.httpStatus, 200); assert.equal(result.body.status, expired ? "expired" : "pending");
    assert.deepEqual(result.body.transaction, { txHash, status: "unverified" });
  });
  for (const outcome of ["reverted", "event-mismatch"] as const) {
    test(`${outcome} is a transaction error and preserves ${expired ? "expired" : "pending"} invoice`, async (t) => {
      const { rpc, service } = setup(t);
      const r = receipt();
      if (outcome === "reverted") r.status = "0x0";
      else r.logs[0]!.address = "0x0000000000000000000000000000000000099999";
      rpc.receipts.set(txHash, r); rpc.timestamp += expired ? 1 : 0;
      const result = await service.lookup(invoiceId, txHash);
      assert.equal(result.httpStatus, 422); assert.equal(result.body.status, expired ? "expired" : "pending");
      assert.equal(result.body.transaction?.status, outcome);
      assert.equal(result.body.receipt, null);
    });
  }
}

test("RPC outage keeps the last successful snapshot and applies 2/4/8/16/30 second backoff", async (t) => {
  const { rpc, service, advance } = setup(t);
  const previous = await service.lookup(invoiceId);
  rpc.available = false;
  let result = await service.lookup(invoiceId, txHash);
  assert.equal(result.httpStatus, 503); assert.equal(result.body.updatedAt, previous.body.updatedAt);
  assert.equal(result.body.status === "rpc-error" && result.body.lastKnownStatus, "pending");
  assert.deepEqual(result.body.transaction, { txHash, status: "unverified" });
  for (const seconds of [2, 4, 8, 16, 30, 30]) {
    assert.equal(result.retryAfterSeconds, seconds);
    const count = rpc.calls.length;
    await service.lookup(invoiceId, otherHash);
    assert.equal(rpc.calls.length, count);
    advance(seconds * 1000);
    result = await service.lookup(invoiceId);
  }
  rpc.available = true; advance(30_000);
  assert.equal((await service.lookup(invoiceId)).httpStatus, 200);
});

test("RPC failure before first snapshot returns null timestamps; wrong chain is explicit", async (t) => {
  const { rpc, service, advance } = setup(t);
  rpc.available = false;
  let result = await service.lookup(invoiceId);
  assert.equal(result.body.updatedAt, null);
  assert.equal(result.body.status === "rpc-error" && result.body.lastKnownStatus, null);
  rpc.available = true; rpc.chain = "0xa869"; advance(2000);
  result = await service.lookup(invoiceId);
  assert.equal(result.body.status === "rpc-error" && result.body.error.code, "WRONG_CHAIN");
});

test("a payment executed before expiry can be discovered after expiry and outage", async (t) => {
  const { rpc, service, advance } = setup(t);
  rpc.head = 129; rpc.timestamp = envelope.invoice.expiresAt + 10;
  assert.equal((await service.lookup(invoiceId)).body.status, "expired");
  rpc.available = false; assert.equal((await service.lookup(invoiceId)).httpStatus, 503);
  rpc.available = true; rpc.settle();
  rpc.blocks.set(128, { timestamp: envelope.invoice.expiresAt, hash: receipt().blockHash });
  advance(2000);
  // The paid getter detects the earlier log gap and rewinds the durable scan cursor.
  assert.equal((await service.lookup(invoiceId)).httpStatus, 503);
  advance(4000);
  assert.equal((await service.lookup(invoiceId)).body.status, "paid");
});

test("isInvoicePaid alone and logs without a receipt cannot produce paid", async (t) => {
  const { rpc, service, advance } = setup(t);
  rpc.paid = true;
  assert.equal((await service.lookup(invoiceId)).httpStatus, 503);
  rpc.logs = receipt().logs; advance(2000);
  assert.equal((await service.lookup(invoiceId)).httpStatus, 503);
  rpc.receipts.set(txHash, receipt()); advance(4000);
  assert.equal((await service.lookup(invoiceId)).body.status, "paid");
});

test("a valid hinted receipt can resolve a missing log query result", async (t) => {
  const { rpc, service } = setup(t);
  rpc.paid = true; rpc.receipts.set(txHash, receipt());
  assert.equal((await service.lookup(invoiceId, txHash)).body.status, "paid");
});

for (const corruption of ["receipt-hash", "receipt-block", "canonical-block", "late-block"] as const) {
  test(`inconsistent ${corruption} cannot confirm payment`, async (t) => {
    const { rpc, service } = setup(t);
    const r = receipt();
    if (corruption === "receipt-hash") r.transactionHash = otherHash;
    if (corruption === "receipt-block") r.blockNumber = "0x81";
    if (corruption === "canonical-block") rpc.blocks.set(128, { hash: otherHash, timestamp: rpc.timestamp });
    if (corruption === "late-block") rpc.timestamp++;
    rpc.receipts.set(txHash, r);
    const result = await service.lookup(invoiceId, txHash);
    assert.equal(result.body.receipt, null);
    assert.equal(result.httpStatus, corruption === "late-block" ? 422 : 503);
  });
}

test("bounded log scans checkpoint complete ranges and eventually reach the head", async (t) => {
  const { rpc, repository, service, advance } = setup(t, { blockRange: 2, maxScanRanges: 1 });
  rpc.head = 5;
  for (const seconds of [2, 4, 8]) {
    assert.equal((await service.lookup(invoiceId)).httpStatus, 503);
    assert(repository.get(invoiceId)!.nextScanBlock! > 1);
    advance(seconds * 1000);
  }
  assert.equal((await service.lookup(invoiceId)).body.status, "pending");
  const ranges = rpc.calls.filter((c) => c.method === "eth_getLogs").map((c) => c.params[0]);
  assert.deepEqual(ranges.map((r) => (r as { fromBlock: string }).fromBlock), ["0x1", "0x2", "0x3", "0x4"]);
});

test("invoice, snapshot, unresolved hash, cursor and final receipt survive reopening SQLite", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "intracampus-b02-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "invoices.sqlite");
  let repository = new SqliteInvoiceRepository(path);
  repository.create(envelope);
  assert.throws(() => repository.create(envelope));
  const rpc = new FakeRpc();
  let service = new ReceiptService({ repository, rpc, deployment });
  await service.lookup(invoiceId, txHash);
  const saved = repository.get(invoiceId);
  repository.close();
  repository = new SqliteInvoiceRepository(path);
  assert.deepEqual(repository.get(invoiceId), saved);
  service = new ReceiptService({ repository, rpc, deployment });
  rpc.settle();
  const confirmed = await service.lookup(invoiceId);
  repository.close();
  repository = new SqliteInvoiceRepository(path);
  try {
    rpc.available = false;
    service = new ReceiptService({ repository, rpc });
    assert.deepEqual(await service.lookup(invoiceId, otherHash), confirmed);
  } finally { repository.close(); }
});

test("missing or mismatched trusted deployment fails closed", async (t) => {
  const { repository, rpc } = setup(t);
  for (const configured of [undefined, { ...deployment, contractAddress: "0x0000000000000000000000000000000000099999" }]) {
    const service = new ReceiptService({ repository, rpc, deployment: configured });
    assert.equal((await service.lookup(invoiceId)).httpStatus, 503);
  }
  assert.equal(rpc.calls.length, 0);
});
