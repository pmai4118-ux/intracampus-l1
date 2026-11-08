import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { campusNetwork } from "../packages/network/src/index.ts";

export const allowedMethods = new Set([
  "eth_chainId", "net_version", "net_listening", "web3_clientVersion",
  "eth_blockNumber", "eth_getBalance", "eth_getTransactionCount", "eth_getCode",
  "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas",
  "eth_feeHistory", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs",
  "eth_sendRawTransaction",
]);

const maxRequestBytes = 256 * 1024;
const maxResponseBytes = 2 * 1024 * 1024;
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxRequestBytes) {
        if (!tooLarge) reject(new Error("Request too large"));
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Request aborted")));
  });
}

export function validateUpstream(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.username || url.password || url.search || url.hash ||
      !/^\/ext\/bc\/[A-Za-z0-9]+\/rpc$/.test(url.pathname)) {
    throw new Error("RPC_UPSTREAM must be http://127.0.0.1:<port>/ext/bc/<blockchain-id>/rpc");
  }
  return url.href;
}

export async function verifyChain(upstream, timeoutMs = 8000) {
  const response = await fetch(validateUpstream(upstream), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    redirect: "error", signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (!response.ok || body.jsonrpc !== "2.0" || body.id !== 1 || body.error ||
      typeof body.result !== "string" || !/^0x[0-9a-f]+$/i.test(body.result) ||
      BigInt(body.result) !== BigInt(campusNetwork.chainId)) {
    throw new Error(`Upstream must return chain ID ${campusNetwork.chainId}`);
  }
}

export function createRpcGateway({ upstream, origins = [], timeoutMs = 8000 }) {
  const target = validateUpstream(upstream);
  const checkPage = readFileSync(new URL("./rpc-check.html", import.meta.url));
  const acceptedOrigins = new Set(origins);
  for (const origin of acceptedOrigins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error("RPC_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths/trailing slashes");
    }
  }
  let activeRequests = 0;
  const server = createServer(async (req, res) => {
    if (req.url === "/check" && ["GET", "HEAD"].includes(req.method)) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(req.method === "HEAD" ? undefined : checkPage);
    }
    if (req.url !== "/rpc") return send(res, 404, { error: "Not found" });
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    if (origin && !acceptedOrigins.has(origin)) return send(res, 403, { error: "Origin denied" });
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    if (req.method === "OPTIONS") {
      if (req.headers["access-control-request-method"] !== "POST") {
        return send(res, 405, { error: "Only POST is supported" });
      }
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
      });
      return res.end();
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return send(res, 405, { error: "Only POST is supported" });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
      return send(res, 415, { error: "Use application/json" });
    }
    if (activeRequests >= 8) return send(res, 429, rpcError(null, -32000, "Gateway busy; retry later"));
    activeRequests++;
    try {
      let raw;
      try { raw = await readBody(req); }
      catch { return send(res, 413, rpcError(null, -32000, "Request too large or interrupted")); }
      let payload;
      try { payload = JSON.parse(raw); }
      catch { return send(res, 400, rpcError(null, -32700, "Invalid JSON")); }
      const calls = Array.isArray(payload) ? payload : [payload];
      if (calls.length < 1 || calls.length > 20) {
        return send(res, 400, rpcError(null, -32600, "Batch must contain 1 to 20 calls"));
      }
      // Validate the entire batch before forwarding any of its calls.
      for (const call of calls) {
        if (!call || typeof call !== "object" || Array.isArray(call) ||
            call.jsonrpc !== "2.0" || typeof call.method !== "string" ||
            !(typeof call.id === "string" || Number.isSafeInteger(call.id)) ||
            (call.params !== undefined && !Array.isArray(call.params))) {
          return send(res, 400, rpcError(null, -32600, "Require JSON-RPC 2.0, id and array params"));
        }
        if (!allowedMethods.has(call.method)) {
          return send(res, 403, rpcError(call.id, -32601, "RPC method denied by demo gateway"));
        }
      }
      const response = await fetch(target, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error("Upstream HTTP error");
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxResponseBytes) throw new Error("Upstream response too large");
        chunks.push(Buffer.from(chunk));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return send(res, 200, result);
    } catch (error) {
      return send(res, error.name === "TimeoutError" ? 504 : 502,
        rpcError(null, -32000, "Upstream unavailable; payment status is unverified"));
    } finally { activeRequests--; }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  return server;
}

async function main() {
  const upstream = validateUpstream(process.env.RPC_UPSTREAM);
  const origins = (process.env.RPC_ALLOWED_ORIGINS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const port = Number(process.env.RPC_GATEWAY_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid RPC_GATEWAY_PORT");
  await verifyChain(upstream);
  const server = createRpcGateway({ upstream, origins });
  server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Demo RPC gateway http://127.0.0.1:${port}/rpc; verified chain ${campusNetwork.chainId}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
