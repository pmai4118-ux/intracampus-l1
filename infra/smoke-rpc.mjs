import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { campusNetwork } from "../packages/network/src/index.ts";

export async function smokeRpc(endpoint, txHash, { allowLocalHttp = false, origin } = {}) {
  const url = new URL(endpoint);
  const localHttp = allowLocalHttp && url.protocol === "http:" && url.hostname === "127.0.0.1";
  assert.ok(url.protocol === "https:" || localHttp, "Require HTTPS (local test may use --local)");
  assert.ok(!url.username && !url.password && !url.search && !url.hash, "Use a URL without credentials/query/fragment");
  assert.equal(url.pathname, "/rpc", "Use the gateway URL ending in /rpc");
  assert.match(txHash, /^0x[0-9a-f]{64}$/i, "Require a real transaction hash");

  async function post(payload) {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (origin) assert.equal(response.headers.get("access-control-allow-origin"), origin, "CORS origin mismatch");
    return { response, body: await response.json() };
  }
  async function rpc(id, method, params) {
    const { response, body } = await post({ jsonrpc: "2.0", id, method, params });
    assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, id);
    assert.ok(!body.error, `${method} returned an RPC error`);
    return body.result;
  }

  const chainId = await rpc(1, "eth_chainId", []);
  assert.match(chainId, /^0x[0-9a-f]+$/i);
  assert.equal(BigInt(chainId), BigInt(campusNetwork.chainId), "Wrong chain");
  const receipt = await rpc(2, "eth_getTransactionReceipt", [txHash]);
  assert.ok(receipt && typeof receipt === "object", "Receipt not found; check network history and tx hash");
  assert.equal(receipt.transactionHash?.toLowerCase(), txHash.toLowerCase(), "Receipt hash mismatch");
  assert.equal(receipt.status, "0x1", "Transaction did not succeed");
  assert.match(receipt.blockHash, /^0x[0-9a-f]{64}$/i);
  for (const field of ["blockNumber", "gasUsed", "effectiveGasPrice"]) {
    assert.match(receipt[field], /^0x[0-9a-f]+$/i, `Missing/invalid ${field}`);
  }
  for (const path of ["/", "/ext/admin", "/ext/info", "/ext/health", "/metrics", "/dashboard"]) {
    const blocked = await fetch(new URL(path, url), { redirect: "error", signal: AbortSignal.timeout(10000) });
    await blocked.text();
    assert.equal(blocked.status, 404, `Unexpected exposed route: ${path}`);
  }
  // A denied method must be rejected even inside a batch with an allowed method.
  const denied = await post([
    { jsonrpc: "2.0", id: 3, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 4, method: "admin.peers", params: [] },
  ]);
  assert.equal(denied.response.status, 403, "Admin batch must be denied");
  assert.equal(denied.body.error?.code, -32601);
  if (origin) {
    const preflight = await fetch(url, {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
      redirect: "error", signal: AbortSignal.timeout(10000),
    });
    assert.equal(preflight.status, 204, "CORS preflight failed");
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /content-type/i);
  }
  return {
    environment: localHttp ? "local fixture/gateway test; not L02 HTTPS evidence" : "HTTPS endpoint; record actual device/network separately",
    checkedAt: new Date().toISOString(), endpoint: url.href, chainId: Number(BigInt(chainId)),
    receipt: { transactionHash: receipt.transactionHash, status: receipt.status, blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice },
    blockedRoutes: "pass", adminBatch: "denied", cors: origin ? "pass" : "not tested",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const local = args[0] === "--local";
  if (local) args.shift();
  if (args.length !== 2) {
    console.error("Usage: bash infra/smoke-rpc.sh [--local] <https://host/rpc> <tx-hash>");
    process.exitCode = 1;
  } else {
    smokeRpc(args[0], args[1], { allowLocalHttp: local, origin: process.env.RPC_TEST_ORIGIN })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
  }
}
