import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { type TestContext } from "node:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface, Wallet, TypedDataEncoder, id, verifyTypedData } from "ethers";
import { SqliteInvoiceRepository } from "../src/modules/invoices/invoices.repository.ts";
import { HttpInvoiceRpc } from "../src/modules/invoices/invoices.rpc.ts";
import { InvoiceCreationService, invoiceTypes } from "../src/modules/invoices/invoices.service.ts";
import { readInvoiceCreationConfig } from "../src/modules/invoices/invoice.config.ts";
import { ReceiptService } from "../src/modules/invoices/receipt.service.ts";

const fixture = JSON.parse(readFileSync(new URL("../../docs/fixtures/invoice-v1.json", import.meta.url), "utf8"));
// Published Anvil mnemonic, used exclusively with synthetic RPC / local EVM.
const wallet = Wallet.fromPhrase("test test test test test test test test test test test junk");
const request = { merchantId: "parking-demo", serviceId: "parking-single" };
const abi = new Interface(["function posSigner() view returns (address)"]);

async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function setup(t: TestContext, options: { config?: Record<string, string | undefined>; noDeployment?: boolean; disk?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "b01-"));
  const path = options.disk ? join(dir, "invoices.sqlite") : ":memory:";
  const repository = new SqliteInvoiceRepository(path);
  t.after(() => { repository.close(); rmSync(dir, { recursive: true, force: true }); });
  const state = { chain: "0x4f25", signer: wallet.address, fail: false, badSigner: false,
    timestamp: fixture.envelope.meta.issuedAt, malformed: false, badProtocol: false };
  const rpcUrl = await serve(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("Content-Type", "application/json");
    if (state.fail) { res.statusCode = 503; res.end("{}"); return; }
    let result: unknown;
    if (call.method === "eth_chainId") result = state.chain;
    else if (call.method === "eth_getBlockByNumber") result = state.malformed ? null
      : { number: "0x80", timestamp: `0x${state.timestamp.toString(16)}`, hash: `0x${"ab".repeat(32)}` };
    else if (call.method === "eth_getLogs") result = [];
    else if (call.method === "eth_call") {
      assert.equal(call.params[0].to.toLowerCase(), fixture.envelope.domain.verifyingContract.toLowerCase());
      if (call.params[0].data === abi.encodeFunctionData("posSigner")) {
        assert.equal(call.params[1], "0x80");
        result = state.badSigner ? "0x12" : abi.encodeFunctionResult("posSigner", [state.signer]);
      } else result = `0x${"0".repeat(64)}`;
    } else throw new Error(`Unexpected RPC method ${call.method}`);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: state.badProtocol ? -1 : call.id, result }));
  });
  const deployment = options.noDeployment ? undefined : { contractAddress: fixture.envelope.domain.verifyingContract, deploymentBlock: 1 };
  const rpc = new HttpInvoiceRpc(rpcUrl);
  const env = { POS_SIGNER_PRIVATE_KEY: wallet.privateKey, PARKING_MERCHANT_ADDRESS: fixture.envelope.invoice.merchant, ...options.config };
  const creation = new InvoiceCreationService({ repository, rpc, deployment, config: readInvoiceCreationConfig(env) });
  const receipts = new ReceiptService({ repository, rpc, deployment });
  const api = await serve(t, createApp(rpcUrl, receipts, creation));
  async function post(body: unknown = request) {
    const response = await fetch(`${api}/api/invoices`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { state, post, api, repository, path };
}

test("creates signed server-priced QR, persists before response and exposes it through B02 GET", async (t) => {
  const { post, api, repository } = await setup(t);
  const { status, body, headers } = await post();
  assert.equal(status, 201);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(body.status, "pending"); assert.equal(body.transaction, null);
  const e = body.envelope;
  assert.equal(e.invoice.amount, "3000000000000000000000");
  assert.equal(e.meta.issuedAt, 1794142500);
  assert.equal(e.invoice.expiresAt, 1794142800);
  assert.equal(e.domain.chainId, 20261);
  assert.equal(body.invoiceId, id(e.meta.invoiceCode));
  assert.equal(e.invoice.category, "0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb");
  assert.equal(e.meta.merchantName, "Bãi xe demo");
  assert.deepEqual(body.pricingPreview, { standard: { tier: 0, discountBps: 0, discountAmount: "0", paidAmount: "3000000000000000000000" },
    studentSbt: { tier: 1, discountBps: 1000, discountAmount: "300000000000000000000", paidAmount: "2700000000000000000000" } });
  assert.deepEqual(JSON.parse(body.qrPayload), e);
  assert.equal(body.qrPayload, JSON.stringify(e));
  const parsed = JSON.parse(body.qrPayload);
  assert.equal(TypedDataEncoder.hash(e.domain, fixture.types, e.invoice), TypedDataEncoder.hash(parsed.domain, fixture.types, parsed.invoice));
  assert.equal(verifyTypedData(e.domain, fixture.types, e.invoice, e.signature), wallet.address);
  for (const altered of [{ ...e.invoice, amount: "1" }, { ...e.invoice, expiresAt: e.invoice.expiresAt + 1 }]) {
    assert.notEqual(verifyTypedData(e.domain, fixture.types, altered, e.signature), wallet.address);
  }
  for (const domain of [{ ...e.domain, chainId: 43113 }, { ...e.domain, verifyingContract: fixture.envelope.invoice.merchant }]) {
    assert.notEqual(verifyTypedData(domain, fixture.types, e.invoice, e.signature), wallet.address);
  }
  assert.ok(!JSON.stringify(body).includes(wallet.privateKey));
  assert.deepEqual(repository.get(body.invoiceId)?.envelope, e);
  const lookup = await fetch(`${api}/api/invoices/${body.invoiceId}`);
  assert.equal(lookup.status, 200);
  assert.equal((await lookup.json()).status, "pending");
  if (process.env.B01_EVIDENCE_PATH) {
    writeFileSync(process.env.B01_EVIDENCE_PATH, `${JSON.stringify({
      environment: "synthetic-HTTP-RPC-SQLite; not Avalanche L1", request, httpStatus: status, response: body,
      verification: { digest: TypedDataEncoder.hash(e.domain, fixture.types, e.invoice), recoveredSigner: wallet.address,
        qrRoundTrip: true, persistedBefore201: true, b02LookupStatus: "pending" },
    }, null, 2)}\n`);
  }
});

test("production typed data matches P02 Solidity digest and deterministic signature", async () => {
  const vector = fixture.vectors[0];
  assert.equal(TypedDataEncoder.hash(fixture.envelope.domain, invoiceTypes, fixture.envelope.invoice), vector.expected.digest);
  assert.equal(await wallet.signTypedData(fixture.envelope.domain, invoiceTypes, fixture.envelope.invoice), fixture.envelope.signature);
});

test("concurrent requests generate unique invoice codes/IDs and survive repository reopen", async (t) => {
  const { post, path } = await setup(t, { disk: true });
  const results = await Promise.all(Array.from({ length: 3 }, () => post()));
  assert.ok(results.every((r) => r.status === 201));
  assert.equal(new Set(results.map((r) => r.body.invoiceId)).size, 3);
  assert.equal(new Set(results.map((r) => r.body.envelope.meta.invoiceCode)).size, 3);
  const reopened = new SqliteInvoiceRepository(path);
  try { for (const r of results) assert.deepEqual(reopened.get(r.body.invoiceId)?.envelope, r.body.envelope); }
  finally { reopened.close(); }
});

test("POST rejects invalid inputs and attempted client price/signer overrides", async (t) => {
  const { post } = await setup(t);
  for (const body of [null, [], {}, { ...request, merchantId: 1 }, { ...request, serviceId: "" },
    { ...request, amount: "1" }, { ...request, signer: wallet.address }, { ...request, expiresAt: 9999999999 },
    { ...request, merchantId: "__proto__" }, { ...request, serviceId: "unknown" }]) {
    const r = await post(body);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.retryable, false);
    assert.ok(["INVALID_REQUEST", "UNKNOWN_SERVICE_OR_MERCHANT"].includes(r.body.error.code));
  }
});

test("bad JSON, oversized body and wrong content type return structured P02 errors", async (t) => {
  const { api } = await setup(t);
  for (const [body, contentType] of [["{", "application/json"], [JSON.stringify({ x: "a".repeat(9000) }), "application/json"], [JSON.stringify(request), "text/plain"]]) {
    const r = await fetch(`${api}/api/invoices`, { method: "POST", headers: { "content-type": contentType }, body });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, "INVALID_REQUEST");
  }
});

for (const scenario of ["wrong-chain", "rpc", "bad-protocol", "malformed-block", "bad-signer-data", "wrong-signer", "zero-signer"] as const) {
  test(`fails closed for ${scenario} and recovers after configuration/RPC repair`, async (t) => {
    const { state, post } = await setup(t);
    if (scenario === "wrong-chain") state.chain = "0xa869";
    if (scenario === "rpc") state.fail = true;
    if (scenario === "bad-protocol") state.badProtocol = true;
    if (scenario === "malformed-block") state.malformed = true;
    if (scenario === "bad-signer-data") state.badSigner = true;
    if (scenario === "wrong-signer") state.signer = fixture.envelope.invoice.merchant;
    if (scenario === "zero-signer") state.signer = `0x${"0".repeat(40)}`;
    const r = await post();
    const code = scenario === "wrong-chain" ? "WRONG_CHAIN" : scenario.endsWith("signer") ? "INVALID_SIGNATURE" : "RPC_UNAVAILABLE";
    assert.equal(r.status, code === "INVALID_SIGNATURE" ? 400 : 503);
    assert.equal(r.body.error.code, code);
    assert.ok(!JSON.stringify(r.body).includes(wallet.privateKey));
    Object.assign(state, { chain: "0x4f25", signer: wallet.address, fail: false, badProtocol: false, malformed: false, badSigner: false });
    assert.equal((await post()).status, 201);
  });
}

for (const config of [{ POS_SIGNER_PRIVATE_KEY: undefined }, { POS_SIGNER_PRIVATE_KEY: "secret-not-a-key" },
  { PARKING_MERCHANT_ADDRESS: undefined }, { PARKING_MERCHANT_ADDRESS: "not-an-address" }]) {
  test(`rejects missing/invalid config ${JSON.stringify(Object.keys(config))}`, async (t) => {
    const { post } = await setup(t, { config });
    const r = await post();
    assert.notEqual(r.status, 201);
    assert.ok(!JSON.stringify(r.body).includes("secret-not-a-key"));
  });
}
test("missing deployment never falls back to fixture verifier", async (t) => {
  const { post } = await setup(t, { noDeployment: true });
  assert.equal((await post()).body.error.code, "RPC_UNAVAILABLE");
});

test("malformed chain time fails closed with a retryable RPC error", async (t) => {
  const { post, state } = await setup(t);
  state.timestamp = 8640000000001;
  const result = await post();
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, "RPC_UNAVAILABLE");
  assert.equal(result.body.error.retryable, true);
});

test("storage failure never returns 201 or signed invoice", async (t) => {
  const { post, repository } = await setup(t);
  t.mock.method(repository, "create", () => { throw new Error("private storage details"); });
  const r = await post();
  assert.equal(r.status, 500);
  assert.equal(r.body.error.code, "INTERNAL_ERROR");
  assert.equal(r.body.envelope, undefined);
  assert.ok(!JSON.stringify(r.body).includes("private storage details"));
});

test("POST rejects missing service before consulting deployment or RPC", async (t) => {
  const server = createServer(createApp()).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/invoices`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ merchantId: "parking-demo" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_REQUEST");
});
