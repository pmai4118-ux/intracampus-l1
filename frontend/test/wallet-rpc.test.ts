import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { createWalletRpc } from "../lib/wallet.ts";

async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((done) => { server.close(() => done()); }));
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
test("wallet RPC sends canonical requests, preserves params and accepts matching ID", async (t) => {
  const url = await serve(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.method, "POST"); assert.equal(call.jsonrpc, "2.0");
    assert.equal(call.method, "eth_getBalance"); assert.deepEqual(call.params, ["0x123", "0x10"]);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "0x123456789abcdef" }));
  });
  assert.equal(await createWalletRpc(url)("eth_getBalance", ["0x123", "0x10"]), "0x123456789abcdef");
});
for (const mode of ["wrong-id", "json-error", "missing-result", "bad-json", "http-error", "redirect", "oversized"]) {
  test(`wallet RPC rejects ${mode}`, async (t) => {
    const url = await serve(t, async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const call = JSON.parse(Buffer.concat(chunks).toString());
      if (mode === "http-error") res.statusCode = 503;
      if (mode === "redirect") { res.statusCode = 302; res.setHeader("Location", "/rpc"); }
      res.setHeader("Content-Type", "application/json");
      res.end(mode === "bad-json" ? "{" : mode === "oversized" ? "a".repeat(256 * 1024 + 1) : JSON.stringify({
        jsonrpc: "2.0", id: mode === "wrong-id" ? call.id + 1 : call.id,
        ...(mode === "missing-result" ? {} : { result: "0x4f25" }),
        ...(mode === "json-error" ? { error: { code: -32000, message: "failed" } } : {}),
      }));
    });
    await assert.rejects(createWalletRpc(url)("eth_chainId", []));
  });
}
test("aborted wallet read does not wait for a stale network response", async (t) => {
  const url = await serve(t, (_req, res) => { res.end("{}"); });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(createWalletRpc(url)("eth_chainId", [], abort.signal));
});
