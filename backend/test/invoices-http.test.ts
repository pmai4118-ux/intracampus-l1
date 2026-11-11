import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";
import { SqliteInvoiceRepository } from "../src/modules/invoices/invoices.repository.ts";
import { HttpInvoiceRpc } from "../src/modules/invoices/invoices.rpc.ts";
import { ReceiptService } from "../src/modules/invoices/receipt.service.ts";
import { readInvoiceDeployment } from "../src/modules/invoices/receipt.config.ts";
import { deployment, envelope, FakeRpc, invoiceId, otherHash, receipt, txHash } from "./invoices.helpers.ts";

async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("HTTP lookup returns the documented 200/503 shapes and no-store/retry headers", async (t) => {
  const repository = new SqliteInvoiceRepository(":memory:");
  t.after(() => repository.close()); repository.create(envelope);
  const rpc = new FakeRpc();
  const service = new ReceiptService({ repository, rpc, deployment });
  const api = await serve(t, createApp(undefined, service));
  let response = await fetch(`${api}/api/invoices/${invoiceId}?txHash=${txHash}`);
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  let body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["invoiceId", "status", "envelope", "receipt", "transaction", "updatedAt"].sort());
  assert.deepEqual(body.envelope, envelope); assert.equal(body.transaction.status, "unverified");
  rpc.available = false;
  response = await fetch(`${api}/api/invoices/${invoiceId}`);
  assert.equal(response.status, 503); assert.equal(response.headers.get("Retry-After"), "2");
  body = await response.json(); assert.equal(body.status, "rpc-error"); assert.equal(body.lastKnownStatus, "pending");
  assert.equal(body.error.retryable, true); assert.equal(body.transaction.txHash, txHash);
});

test("HTTP reverted transaction returns the full 422 lookup snapshot", async (t) => {
  const repository = new SqliteInvoiceRepository(":memory:");
  t.after(() => repository.close()); repository.create(envelope);
  const rpc = new FakeRpc(); rpc.receipts.set(txHash, { ...receipt(), status: "0x0" });
  const api = await serve(t, createApp(undefined, new ReceiptService({ repository, rpc, deployment })));
  const response = await fetch(`${api}/api/invoices/${invoiceId}?txHash=${txHash}`);
  const body = await response.json();
  assert.equal(response.status, 422); assert.equal(body.status, "pending");
  assert.deepEqual(body.envelope, envelope); assert.equal(body.receipt, null);
  assert.equal(body.transaction.status, "reverted"); assert.equal(body.error.code, "TX_REVERTED");
});

test("HTTP discovery works end to end through actual JSON-RPC requests", async (t) => {
  const repository = new SqliteInvoiceRepository(":memory:");
  t.after(() => repository.close()); repository.create(envelope);
  const fake = new FakeRpc(); fake.settle();
  const rpcUrl = await serve(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: await fake.call(method, params) }));
  });
  const service = new ReceiptService({ repository, rpc: new HttpInvoiceRpc(rpcUrl), deployment });
  const api = await serve(t, createApp(rpcUrl, service));
  const response = await fetch(`${api}/api/invoices/${invoiceId}?txHash=${otherHash}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "paid"); assert.equal(body.receipt.txHash, txHash);
  assert.equal(body.receipt.paidAmount, "3000000000000000000000");
});

test("HTTP validation rejects malformed IDs, duplicate hashes and unknown queries", async (t) => {
  const repository = new SqliteInvoiceRepository(":memory:");
  t.after(() => repository.close()); repository.create(envelope);
  const rpc = new FakeRpc();
  const api = await serve(t, createApp(undefined, new ReceiptService({ repository, rpc, deployment })));
  for (const suffix of ["bad", `${invoiceId}?txHash=bad`, `${invoiceId}?txHash=${txHash}&txHash=${otherHash}`,
    `${invoiceId}?txHash[x]=${txHash}`, `${invoiceId}?other=1`]) {
    const response = await fetch(`${api}/api/invoices/${suffix}`);
    assert.equal(response.status, 400, suffix);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
  const response = await fetch(`${api}/api/invoices/${otherHash}`);
  assert.equal(response.status, 404); assert.equal((await response.json()).error.code, "INVOICE_NOT_FOUND");
  assert.equal(rpc.calls.length, 0);
});

test("a database commit failure returns generic 500 and never exposes a paid receipt", async (t) => {
  const repository = new SqliteInvoiceRepository(":memory:");
  t.after(() => repository.close()); repository.create(envelope);
  const rpc = new FakeRpc(); rpc.settle();
  repository.confirm = () => { throw new Error("secret database path"); };
  const api = await serve(t, createApp(undefined, new ReceiptService({ repository, rpc, deployment })));
  const response = await fetch(`${api}/api/invoices/${invoiceId}`);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert(!text.includes("secret")); assert.equal(JSON.parse(text).error.code, "INTERNAL_ERROR");
  assert.equal(repository.get(invoiceId)?.receipt, null);
});

for (const failure of ["wrong-id", "rpc-error", "missing-result", "bad-json", "http-error", "oversized", "redirect"] as const) {
  test(`RPC transport rejects ${failure}`, async (t) => {
    const url = await serve(t, async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const { id } = JSON.parse(Buffer.concat(chunks).toString());
      if (failure === "http-error") { res.writeHead(503).end(); return; }
      if (failure === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1" }).end(); return; }
      const payload = failure === "wrong-id" ? { jsonrpc: "2.0", id: id + 1, result: "0x4f25" }
        : failure === "rpc-error" ? { jsonrpc: "2.0", id, error: { code: -1, message: "secret" } }
        : { jsonrpc: "2.0", id };
      res.end(failure === "bad-json" ? "{" : failure === "oversized" ? "x".repeat(2 * 1024 * 1024 + 1) : JSON.stringify(payload));
    });
    await assert.rejects(new HttpInvoiceRpc(url).call("eth_chainId", []), { message: "RPC_UNAVAILABLE" });
  });
}

test("deployment configuration accepts only a complete trusted address/block pair", () => {
  assert.equal(readInvoiceDeployment({}), undefined);
  assert.deepEqual(readInvoiceDeployment({ CAMPUS_PAYMENT_REGISTRY_ADDRESS: deployment.contractAddress, CAMPUS_PAYMENT_DEPLOYMENT_BLOCK: "0" }), { ...deployment, deploymentBlock: 0 });
  for (const config of [
    { CAMPUS_PAYMENT_REGISTRY_ADDRESS: deployment.contractAddress },
    { CAMPUS_PAYMENT_DEPLOYMENT_BLOCK: "1" },
    { CAMPUS_PAYMENT_REGISTRY_ADDRESS: deployment.contractAddress, CAMPUS_PAYMENT_DEPLOYMENT_BLOCK: "1e3" },
    { CAMPUS_PAYMENT_REGISTRY_ADDRESS: deployment.contractAddress, CAMPUS_PAYMENT_DEPLOYMENT_BLOCK: "9007199254740992" },
  ]) assert.throws(() => readInvoiceDeployment(config));
});
