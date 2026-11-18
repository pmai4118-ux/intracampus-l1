import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { createApp } from "../src/app.ts";
import { probeNetwork } from "../src/modules/network/network.service.ts";

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
    const methods: unknown[] = [];
    const rpc = await serve(t, async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const method = JSON.parse(Buffer.concat(chunks).toString()).method;
      methods.push(method);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_chainId" ? hex : { number: "0xd", timestamp: "0x64" } }));
    });
    const api = await serve(t, createApp(rpc));
    const response = await fetch(`${api}/api/network`);
    assert.equal(response.status, httpStatus);
    const body = await response.json();
    assert.equal(body.status, status);
    assert.equal(body.chainId, chainId);
    assert.equal(body.expectedChainId, 20261);
    assert.deepEqual(body.latestBlock, { number: 13, timestamp: 100 });
    assert.ok(body.headAgeSeconds > 0);
    assert.deepEqual(methods.sort(), ["eth_chainId", "eth_getBlockByNumber"]);
  });
}

for (const timestamp of ["0x64", "0x12c"]) {
  test(`head age preserves past/future timestamp ${timestamp}`, async (t) => {
    const rpc = await serve(t, async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const { method } = JSON.parse(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_chainId" ? "0x4f25" : { number: "0xd", timestamp } }));
    });
    const result = await probeNetwork(rpc, () => 200000);
    assert.equal(result.status, "ready");
    if (result.status === "ready") assert.equal(result.headAgeSeconds, 200 - Number(BigInt(timestamp)));
  });
}

for (const block of [null, {}, { number: "0xd", timestamp: "yesterday" }, { number: "0x20000000000000", timestamp: "0x64" }]) {
  test(`malformed head cannot report ready: ${JSON.stringify(block)}`, async (t) => {
    const rpc = await serve(t, async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const { method } = JSON.parse(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_chainId" ? "0x4f25" : block }));
    });
    assert.equal((await probeNetwork(rpc)).status, "unreachable");
  });
}
