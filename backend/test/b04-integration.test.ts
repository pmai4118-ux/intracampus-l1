import assert from "node:assert/strict";
import test from "node:test";
import { verifyTypedData } from "ethers";
import { invoiceTypes } from "../src/modules/invoices/invoices.service.ts";
import { createB04Fixture } from "./b04-fixture.ts";

test("B04 real POST/GET routes reject false success, recover RPC and retain committed receipt after SQLite restart", async () => {
  const f = await createB04Fixture();
  try {
    const created = await f.post();
    const e = created.envelope;
    assert.equal(verifyTypedData(e.domain, invoiceTypes, e.invoice, e.signature).toLowerCase(), e.signer.toLowerCase());
    let response = await fetch(`${f.api}/api/invoices/${created.invoiceId}`);
    assert.equal((await response.json()).status, "pending");
    f.rpc.available = false;
    response = await fetch(`${f.api}/api/invoices/${created.invoiceId}`);
    assert.equal(response.status, 503); assert.ok(response.headers.get("Retry-After"));
    assert.equal((await response.json()).receipt, null);
    f.rpc.available = true; f.advance();
    for (const mode of ["reverted", "mismatch"] as const) {
      const txHash = f.settle(e, mode);
      response = await fetch(`${f.api}/api/invoices/${created.invoiceId}?txHash=${txHash}`);
      assert.equal(response.status, 422); const body = await response.json();
      assert.notEqual(body.status, "paid"); assert.equal(body.receipt, null);
    }
    const txHash = f.settle(e, "paid");
    response = await fetch(`${f.api}/api/invoices/${created.invoiceId}?txHash=${txHash}`);
    const paid = await response.json(); assert.equal(response.status, 200); assert.equal(paid.status, "paid");
    assert.equal(paid.receipt.invoiceId, created.invoiceId); assert.equal(paid.receipt.txHash, txHash);
    assert.equal(paid.receipt.originalAmount, e.invoice.amount);
    assert.equal(paid.receipt.contractAddress.toLowerCase(), e.domain.verifyingContract.toLowerCase());
    await f.restart(); f.rpc.available = false;
    response = await fetch(`${f.api}/api/invoices/${created.invoiceId}`);
    const restored = await response.json(); assert.equal(response.status, 200);
    assert.deepEqual(restored, paid); assert.equal(f.logs.filter((log) => log.event === "invoice_paid").length, 1);
  } finally { await f.close(); }
});
