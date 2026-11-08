import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { allowedMethods, createRpcGateway, validateUpstream, verifyChain } from "../rpc-gateway.mjs";
import { smokeRpc } from "../smoke-rpc.mjs";

const txHash = `0x${"a".repeat(64)}`;
const blockHash = `0x${"b".repeat(64)}`;
const appOrigin = "https://demo.example.com";

async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { chain = "0x4f25", receiptStatus = "0x1", missingReceipt = false, timeoutMs = 1000, upstreamMode } = {}) {
  const seen = [];
  const node = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ path: req.url, payload });
    if (upstreamMode === "timeout") return;
    if (upstreamMode === "redirect") { res.writeHead(302, { Location: "/ext/admin" }); return res.end(); }
    if (upstreamMode === "http-error") { res.writeHead(500); return res.end(); }
    const reply = (call) => ({ jsonrpc: "2.0", id: call.id, result: call.method === "eth_getTransactionReceipt"
      ? (missingReceipt ? null : { transactionHash: txHash, blockHash, blockNumber: "0x1", status: receiptStatus, gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca01" })
      : chain });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(Array.isArray(payload) ? payload.map(reply) : reply(payload)));
  });
  const upstream = `${await listen(t, node)}/ext/bc/fixtureBlockchain/rpc`;
  const gateway = createRpcGateway({ upstream, origins: [appOrigin], timeoutMs });
  const base = await listen(t, gateway);
  const post = (body, headers = {}) => fetch(`${base}/rpc`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { upstream, base, seen, post };
}

const call = (method, id = 1) => ({ jsonrpc: "2.0", id, method, params: [] });

test("startup verifies chain and smoke validates receipt, route isolation, batch rejection and CORS", async (t) => {
  const f = await fixture(t);
  await verifyChain(f.upstream);
  const result = await smokeRpc(`${f.base}/rpc`, txHash, { allowLocalHttp: true, origin: appOrigin });
  assert.equal(result.chainId, 20261);
  assert.equal(result.cors, "pass");
  assert.equal(result.receipt.transactionHash, txHash);
  assert.ok(f.seen.every((request) => request.path === "/ext/bc/fixtureBlockchain/rpc"));
  assert.equal(f.seen.length, 3, "route/admin probes must never reach upstream");
  const checkPage = await fetch(`${f.base}/check`);
  assert.equal(checkPage.status, 200);
  assert.match(checkPage.headers.get("content-type"), /text\/html/);
  assert.match(await checkPage.text(), /Kiểm tra RPC L02/);
  assert.equal(f.seen.length, 3, "diagnostic page must not proxy requests to node");
});

test("blocked methods, mixed batches and unexpected paths never reach the node", async (t) => {
  const f = await fixture(t);
  for (const method of ["admin.peers", "admin_peers", "debug_traceTransaction", "personal_unlockAccount", "eth_sendTransaction", "eth_sign"]) {
    const response = await f.post(call(method));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, -32601);
  }
  assert.equal((await f.post([call("eth_chainId"), call("admin.peers", 2)])).status, 403);
  for (const path of ["/", "/ext/admin", "/ext/bc/fixtureBlockchain/rpc", "/rpc?target=/ext/admin", "/rpc/"]) {
    assert.equal((await fetch(`${f.base}${path}`)).status, 404);
  }
  assert.equal(f.seen.length, 0);
  assert.ok(allowedMethods.has("eth_sendRawTransaction"), "wallet-signed transactions can be broadcast");
});

test("allowed batches, wallet requests without Origin and configured preflight work", async (t) => {
  const f = await fixture(t);
  const response = await f.post([call("eth_chainId"), call("eth_blockNumber", 2)]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).length, 2);
  const denied = await f.post(call("eth_chainId"), { Origin: "https://other.example.com" });
  assert.equal(denied.status, 403);
  assert.equal(f.seen.length, 1);
  const preflight = await fetch(`${f.base}/rpc`, { method: "OPTIONS", headers: { Origin: appOrigin, "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), appOrigin);
});

test("invalid JSON, notifications, large bodies and unsupported HTTP methods are rejected", async (t) => {
  const f = await fixture(t);
  for (const value of [null, [], call("eth_chainId", null), { jsonrpc: "2.0", method: "eth_chainId" }, Array.from({ length: 21 }, () => call("eth_chainId"))]) {
    assert.equal((await f.post(value)).status, 400);
  }
  const invalid = await fetch(`${f.base}/rpc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, -32700);
  assert.equal((await f.post({ ...call("eth_chainId"), padding: "x".repeat(256 * 1024) })).status, 413);
  assert.equal((await fetch(`${f.base}/rpc`)).status, 405);
  assert.equal((await f.post(call("eth_chainId"), { "Content-Type": "text/plain" })).status, 415);
  assert.equal(f.seen.length, 0);
});

test("startup rejects the wrong chain and unsafe upstream configuration", async (t) => {
  const f = await fixture(t, { chain: "0xa869" });
  await assert.rejects(verifyChain(f.upstream), /chain ID 20261/);
  for (const value of ["http://example.com/ext/bc/demo/rpc", "http://127.0.0.1:9654/ext/admin", "http://127.0.0.1:9654/ext/bc/demo/rpc?x=1", "http://user:pass@127.0.0.1/ext/bc/demo/rpc"]) {
    assert.throws(() => validateUpstream(value));
  }
  assert.throws(() => createRpcGateway({ upstream: f.upstream, origins: ["https://demo.example.com/path"] }));
});

for (const options of [{ chain: "0xa869" }, { receiptStatus: "0x0" }, { missingReceipt: true }]) {
  test(`smoke fails on ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(smokeRpc(`${f.base}/rpc`, txHash, { allowLocalHttp: true }));
  });
}

test("smoke requires HTTPS unless explicitly using the local test flag", async () => {
  await assert.rejects(smokeRpc("http://127.0.0.1:8787/rpc", txHash), /Require HTTPS/);
  await assert.rejects(smokeRpc("http://example.com/rpc", txHash, { allowLocalHttp: true }), /Require HTTPS/);
});

test("Bash entry point runs the real Node CLI and labels its output as local evidence", async (t) => {
  const f = await fixture(t);
  const { stdout } = await promisify(execFile)("bash", ["infra/smoke-rpc.sh", "--local", `${f.base}/rpc`, txHash], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)), timeout: 10000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.chainId, 20261);
  assert.match(result.environment, /not L02 HTTPS evidence/);
});

test("Bash entry point exits nonzero on the wrong chain", async (t) => {
  const f = await fixture(t, { chain: "0xa869" });
  await assert.rejects(promisify(execFile)("bash", ["infra/smoke-rpc.sh", "--local", `${f.base}/rpc`, txHash], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)), timeout: 10000,
  }), (error) => error.code === 1 && /Wrong chain/.test(error.stderr));
});

for (const options of [{}, { chain: "0xa869" }, { receiptStatus: "0x0" }, { missingReceipt: true }]) {
  test(`mobile diagnostic UI handles ${JSON.stringify(options)} using mocked DOM/RPC`, async (t) => {
    const f = await fixture(t, options);
    const elements = {
      "#check": { addEventListener(_name, handler) { this.submit = handler; } },
      "#result": { textContent: "" }, "#run": { disabled: false },
      "#hash": { value: txHash }, "#network": { value: "4G/5G, đã tắt Wi-Fi" },
    };
    const page = readFileSync(new URL("../rpc-check.html", import.meta.url), "utf8");
    const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    runInNewContext(script, {
      document: { querySelector: (selector) => elements[selector] },
      location: { protocol: "https:", origin: appOrigin }, AbortSignal,
      fetch: (path, init) => fetch(new URL(path, f.base), { ...init, headers: { ...init.headers, Origin: appOrigin } }),
    });
    await elements["#check"].submit({ preventDefault() {} });
    const result = JSON.parse(elements["#result"].textContent);
    assert.equal(result.result, Object.keys(options).length ? "FAIL" : "PASS");
    assert.equal(result.networkDeclared, "4G/5G, đã tắt Wi-Fi");
    assert.equal(elements["#run"].disabled, false);
  });
}

for (const upstreamMode of ["http-error", "redirect", "timeout"]) {
  test(`upstream ${upstreamMode} does not produce a successful RPC response`, async (t) => {
    const f = await fixture(t, { upstreamMode, timeoutMs: 50 });
    const response = await f.post(call("eth_chainId"));
    assert.equal(response.status, upstreamMode === "timeout" ? 504 : 502);
    assert.ok((await response.json()).error);
    assert.equal(f.seen.length, 1, "redirect must not be followed");
  });
}
