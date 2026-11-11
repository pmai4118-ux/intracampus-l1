// Reproducible synthetic P02 evidence. This script does not connect to an L1 or send transactions.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteInvoiceRepository } from "../src/modules/invoices/invoices.repository.ts";
import { ReceiptService } from "../src/modules/invoices/receipt.service.ts";
import { deployment, envelope, FakeRpc, invoiceId, txHash } from "./invoices.helpers.ts";

const path = mkdtempSync(join(tmpdir(), "b02-evidence-"));
const repository = new SqliteInvoiceRepository(join(path, "invoices.sqlite"));
try {
  repository.create(envelope);
  let now = envelope.meta.issuedAt * 1000;
  let notifications = 0;
  const rpc = new FakeRpc();
  const service = new ReceiptService({ repository, rpc, deployment, now: () => now,
    log: (entry) => {
      if (entry.event === "invoice_paid") notifications++;
      console.log(JSON.stringify({ evidence: "synthetic-P02", ...entry }));
    } });
  assert.equal((await service.lookup(invoiceId, txHash)).body.status, "pending");
  rpc.available = false;
  assert.equal((await service.lookup(invoiceId)).httpStatus, 503);
  rpc.available = true; rpc.settle(); now += 2000;
  const paid = await service.lookup(invoiceId);
  assert.equal(paid.body.status, "paid");
  rpc.available = false;
  assert.deepEqual(await service.lookup(invoiceId), paid);
  assert.equal(notifications, 1);
  console.log(JSON.stringify({ evidence: "synthetic-P02", event: "assertions_passed", paymentNotifications: notifications, response: paid.body }));
} finally { repository.close(); rmSync(path, { recursive: true, force: true }); }
