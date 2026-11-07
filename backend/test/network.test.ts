import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";

async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("API stays healthy when developing without an RPC endpoint", async (t) => {
  const api = await serve(t, createApp());
  const health = await fetch(`${api}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const response = await fetch(`${api}/api/network`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "not-configured", expectedChainId: 20261 });
});

for (const { hex, chainId, status, httpStatus } of [
  { hex: "0x4f25", chainId: 20261, status: "ready", httpStatus: 200 },
  { hex: "0xa869", chainId: 43113, status: "wrong-chain", httpStatus: 503 },
]) {
  test(`API reports ${status} for chain ID ${chainId}`, async (t) => {
    let method: unknown;
    const rpc = await serve(t, async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      method = JSON.parse(Buffer.concat(chunks).toString()).method;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hex }));
    });
    const api = await serve(t, createApp(rpc));
    const response = await fetch(`${api}/api/network`);
    assert.equal(response.status, httpStatus);
    assert.deepEqual(await response.json(), { status, expectedChainId: 20261, chainId });
    assert.equal(method, "eth_chainId");
  });
}
