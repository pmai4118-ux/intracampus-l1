import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import express from "express";
import { GrantsReader } from "../src/modules/grants/grants.rpc.ts";
import { GrantsService } from "../src/modules/grants/grants.service.ts";
import { createGrantsRouter } from "../src/modules/grants/grants.routes.ts";
import { address, beneficiary, FOOD, hash, rpcFixture, serve, txHash } from "./grants-read.helpers.ts";

test("HTTP verified zero is distinct from an unavailable balance and never exposes RPC secrets", async (t) => {
  const { rpc, url, provider } = await rpcFixture(t);
  const app = express().use(createGrantsRouter(new GrantsService({ rpcUrl: url, provider, deployment: rpc.deployment, allowLocal: true })));
  const api = await serve(t, app);
  let response = await fetch(`${api}/api/grants/${beneficiary}`);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { schemaVersion: 1, status: "verified", chainId: 20261, beneficiary,
    vaultAddress: address(3), category: { id: FOOD, label: "FOOD" }, balanceWei: "0", block: { number: 10, hash: hash(10) },
    allowedMerchants: [{ id: "canteen", address: address(21), allowed: true }], transaction: null });
  rpc.unavailable = true;
  response = await fetch(`${api}/api/grants/${beneficiary}`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "unverified", chainId: 20261, balanceWei: null,
    error: { code: "RPC_UNAVAILABLE", retryable: true } });
});

test("HTTP rejects malformed public addresses, hashes, duplicate and unknown query fields", async (t) => {
  const api = await serve(t, express().use(createGrantsRouter()));
  for (const suffix of ["bad", address(0), `${beneficiary}?txHash=bad`, `${beneficiary}?txHash=${txHash}&txHash=${hash(91)}`,
    `${beneficiary}?other=1`, `${beneficiary}?txHash[x]=${txHash}`]) {
    const response = await fetch(`${api}/api/grants/${suffix}`);
    assert.equal(response.status, 400, suffix);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
  const response = await fetch(`${api}/api/grants/${beneficiary}`);
  assert.equal(response.status, 503); assert.equal((await response.json()).balanceWei, null);
});

test("snapshot pins balance, code and allowlist reads and reports a revoked merchant", async (t) => {
  const { rpc, provider } = await rpcFixture(t); rpc.balance = 4000n; rpc.allowed = false;
  const result = await new GrantsReader(provider, rpc.deployment).snapshot(beneficiary);
  assert.deepEqual(result, { blockNumber: 10, blockHash: hash(10), balanceWei: 4000n, merchantAllowed: false });
  for (const call of rpc.calls.filter((call) => ["eth_call", "eth_getCode"].includes(call.method))) assert.equal(call.params[1], "0xa");
});

test("snapshot can complete independent code reads concurrently at the pinned block", async (t) => {
  const { rpc, provider } = await rpcFixture(t); rpc.balance = 3000n;
  const send = provider.send.bind(provider); let codeReads = 0;
  provider.send = async (method, params) => {
    if (method === "eth_getCode") {
      codeReads++; await setImmediate();
      if (codeReads < 2) throw new Error("Independent deployment reads were serialized");
    }
    return send(method, params);
  };
  const snapshot = await new GrantsReader(provider, rpc.deployment).snapshot(beneficiary);
  assert.equal(snapshot.balanceWei, 3000n); assert.equal(snapshot.blockHash, hash(10));
});

for (const [label, change, expected] of [
  ["wrong chain", (rpc: Awaited<ReturnType<typeof rpcFixture>>["rpc"]) => { rpc.chainId = "0xa86a"; }, "WRONG_CHAIN"],
  ["changed runtime", (rpc: Awaited<ReturnType<typeof rpcFixture>>["rpc"]) => { rpc.runtime = "0x6001"; }, "DEPLOYMENT_MISMATCH"],
  ["reset deployment blocks", (rpc: Awaited<ReturnType<typeof rpcFixture>>["rpc"]) => { rpc.reset = true; }, "DEPLOYMENT_MISMATCH"],
  ["wrong issuer", (rpc: Awaited<ReturnType<typeof rpcFixture>>["rpc"]) => { rpc.issuer = address(99); }, "DEPLOYMENT_MISMATCH"],
  ["wrong registry", (rpc: Awaited<ReturnType<typeof rpcFixture>>["rpc"]) => { rpc.registryAddress = address(99); }, "DEPLOYMENT_MISMATCH"],
] as const) test(`read refuses ${label}`, async (t) => {
  const { rpc, provider } = await rpcFixture(t); change(rpc);
  await assert.rejects(new GrantsReader(provider, rpc.deployment).snapshot(beneficiary), { message: expected });
});

for (const event of ["GrantIssued", "GrantSpent"] as const) test(`HTTP verifies ${event} receipt, while an absent hash remains pending`, async (t) => {
  const { rpc, url, provider } = await rpcFixture(t);
  const api = await serve(t, express().use(createGrantsRouter(new GrantsService({ rpcUrl: url, provider, deployment: rpc.deployment, allowLocal: true }))));
  let response = await fetch(`${api}/api/grants/${beneficiary}?txHash=${txHash}`);
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).transaction, { hash: txHash, status: "pending", events: [] });
  rpc.settle(event);
  response = await fetch(`${api}/api/grants/${beneficiary}?txHash=${txHash}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.transaction, { hash: txHash, status: "verified", events: [{ event, transactionHash: txHash,
    blockNumber: 10, blockHash: hash(10), logIndex: 0, beneficiary, category: FOOD,
    amountWei: event === "GrantIssued" ? "5000" : "1000", balanceWei: event === "GrantIssued" ? "5000" : "4000",
    ...(event === "GrantIssued" ? { issuer: address(10) } : { merchant: address(21) }) }] });
});

for (const [label, change, expected] of [
  ["revert", (receipt: Record<string, unknown>) => { receipt.status = "0x0"; receipt.logs = []; }, "TX_REVERTED"],
  ["wrong destination", (receipt: Record<string, unknown>) => { receipt.to = address(99); }, "RECEIPT_MISMATCH"],
  ["wrong transaction", (receipt: Record<string, unknown>) => { receipt.transactionHash = hash(99); }, "RECEIPT_MISMATCH"],
  ["orphaned block", (receipt: Record<string, unknown>) => { receipt.blockHash = hash(99); }, "RECEIPT_MISMATCH"],
  ["foreign vault log", (receipt: Record<string, unknown>) => { (receipt.logs as Record<string, unknown>[])[0].address = address(99); }, "RECEIPT_MISMATCH"],
  ["tampered log block", (receipt: Record<string, unknown>) => { (receipt.logs as Record<string, unknown>[])[0].blockHash = hash(99); }, "RECEIPT_MISMATCH"],
  ["removed log", (receipt: Record<string, unknown>) => { (receipt.logs as Record<string, unknown>[])[0].removed = true; }, "RECEIPT_MISMATCH"],
] as const) test(`receipt verification refuses ${label}`, async (t) => {
  const { rpc, provider } = await rpcFixture(t); rpc.settle(); assert(rpc.receipt); change(rpc.receipt);
  await assert.rejects(new GrantsReader(provider, rpc.deployment).verifyReceipt(txHash, beneficiary), { message: expected });
});

test("a valid spend stays verified when its merchant is revoked later in the same block", async (t) => {
  const { rpc, provider } = await rpcFixture(t); rpc.settle("GrantSpent"); rpc.allowed = false;
  const reader = new GrantsReader(provider, rpc.deployment);
  const events = await reader.verifyReceipt(txHash, beneficiary);
  assert.equal(events?.[0].event, "GrantSpent");
  assert.equal((await reader.snapshot(beneficiary)).merchantAllowed, false);
});

test("issued history uses verified receipts even when current balance has been spent", async (t) => {
  const { rpc, provider } = await rpcFixture(t); rpc.settle(); rpc.balance = 0n;
  const events = await new GrantsReader(provider, rpc.deployment).issued(beneficiary, 2010);
  assert.equal(events.length, 1); assert.equal(events[0].amountWei, "5000");
  const scans = rpc.calls.filter((call) => call.method === "eth_getLogs");
  assert.equal(scans.length, 3);
  assert.deepEqual(scans.map((call) => { const filter = call.params[0] as { fromBlock: string; toBlock: string }; return [Number(filter.fromBlock), Number(filter.toBlock)]; }), [[3, 1002], [1003, 2002], [2003, 2010]]);
});

test("empty indexed logs cannot hide prior issuance after the grant is fully spent", async (t) => {
  const { rpc, provider } = await rpcFixture(t);
  rpc.settle(); rpc.balance = 0n; rpc.logs = [];
  const events = await new GrantsReader(provider, rpc.deployment).issued(beneficiary, 10);
  assert.equal(events.length, 1); assert.equal(events[0].amountWei, "5000");
});

test("issued history must belong to the hash of the snapshot it will be reused with", async (t) => {
  const { rpc, provider } = await rpcFixture(t); rpc.settle();
  await assert.rejects(new GrantsReader(provider, rpc.deployment).issued(beneficiary, 10, hash(999)), /CHAIN_CHANGED/);
});

test("absence of issuance cannot be established when a block transaction receipt is unavailable", async (t) => {
  const { rpc, provider } = await rpcFixture(t);
  rpc.settle(); rpc.logs = [];
  const original = rpc.call.bind(rpc);
  rpc.call = (method, params) => method === "eth_getTransactionReceipt" ? null : original(method, params);
  await assert.rejects(new GrantsReader(provider, rpc.deployment).issued(beneficiary, 10), /RPC_UNAVAILABLE/);
});

test("HTTP cannot combine a receipt from an old fork with a balance from the new fork", async (t) => {
  const { rpc, url, provider } = await rpcFixture(t); rpc.settle();
  const original = rpc.call.bind(rpc);
  let changed = false;
  rpc.call = (method, params) => {
    if (method === "eth_getBlockByNumber" && params[0] === "latest") changed = true;
    const result = original(method, params);
    if (changed && method === "eth_getBlockByNumber" && (params[0] === "latest" || params[0] === "0xa")) return { number: "0xa", hash: hash(999) };
    return result;
  };
  const api = await serve(t, express().use(createGrantsRouter(new GrantsService({ rpcUrl: url, provider, deployment: rpc.deployment, allowLocal: true }))));
  const response = await fetch(`${api}/api/grants/${beneficiary}?txHash=${txHash}`);
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "CHAIN_CHANGED");
});

test("HTTP maps reverted and unrelated receipts to 422 without claiming a balance", async (t) => {
  const { rpc, url, provider } = await rpcFixture(t); rpc.settle(); assert(rpc.receipt);
  const api = await serve(t, express().use(createGrantsRouter(new GrantsService({ rpcUrl: url, provider, deployment: rpc.deployment, allowLocal: true }))));
  for (const [status, to, expected] of [["0x0", address(3), "TX_REVERTED"], ["0x1", address(99), "RECEIPT_MISMATCH"]]) {
    rpc.receipt.status = status; rpc.receipt.to = to; rpc.receipt.logs = [];
    const response = await fetch(`${api}/api/grants/${beneficiary}?txHash=${txHash}`);
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { status: "unverified", chainId: 20261, balanceWei: null, error: { code: expected, retryable: false } });
  }
});

for (const [label, change] of [
  ["unrelated target", (receipt: Record<string, unknown>) => { receipt.to = address(99); }],
  ["different transaction", (receipt: Record<string, unknown>) => { receipt.transactionHash = hash(99); }],
  ["orphaned block", (receipt: Record<string, unknown>) => { receipt.blockHash = hash(99); }],
] as const) test(`a reverted receipt with ${label} is a mismatch, not a verified failure`, async (t) => {
  const { rpc, provider } = await rpcFixture(t); rpc.settle(); assert(rpc.receipt);
  rpc.receipt.status = "0x0"; rpc.receipt.logs = []; change(rpc.receipt);
  await assert.rejects(new GrantsReader(provider, rpc.deployment).verifyReceipt(txHash, beneficiary), { message: "RECEIPT_MISMATCH" });
});

for (const [label, change] of [
  ["trailing data", (log: Record<string, unknown>) => { log.data = `${log.data}${"00".repeat(32)}`; }],
  ["extra topic", (log: Record<string, unknown>) => { (log.topics as string[]).push(hash(91)); }],
  ["beneficiary address padding", (log: Record<string, unknown>) => { const topics = log.topics as string[]; topics[1] = `0xff${topics[1].slice(4)}`; }],
  ["issuer address padding", (log: Record<string, unknown>) => { const topics = log.topics as string[]; topics[3] = `0xff${topics[3].slice(4)}`; }],
  ["foreign issuer", (log: Record<string, unknown>) => { (log.topics as string[])[3] = hash(99); }],
  ["foreign beneficiary", (log: Record<string, unknown>) => { (log.topics as string[])[1] = hash(99); }],
  ["unknown category", (log: Record<string, unknown>) => { (log.topics as string[])[2] = hash(99); }],
  ["noncanonical event index", (log: Record<string, unknown>) => { log.logIndex = "0x00"; }],
] as const) test(`receipt refuses ${label} in a GrantIssued event`, async (t) => {
  const { rpc, provider } = await rpcFixture(t); rpc.settle(); assert(rpc.receipt);
  change((rpc.receipt.logs as Record<string, unknown>[])[0]);
  await assert.rejects(new GrantsReader(provider, rpc.deployment).verifyReceipt(txHash, beneficiary), { message: "RECEIPT_MISMATCH" });
});

test("snapshot rejects an invalid boolean return rather than coercing it to allowed", async (t) => {
  const { rpc, provider } = await rpcFixture(t);
  const original = rpc.call.bind(rpc);
  rpc.call = (method, params) => {
    const result = original(method, params);
    if (method === "eth_call" && (params[0] as { to: string }).to === address(2)) return hash(2);
    return result;
  };
  await assert.rejects(new GrantsReader(provider, rpc.deployment).snapshot(beneficiary), { message: "RPC_UNAVAILABLE" });
});

test("service shutdown closes its provider without destroying a caller-owned provider", async (t) => {
  const { rpc, provider, url } = await rpcFixture(t);
  const owned = new GrantsService({ rpcUrl: url, deployment: rpc.deployment, allowLocal: true });
  await owned.lookup(beneficiary); owned.close();
  await assert.rejects(owned.lookup(beneficiary), { message: "RPC_UNAVAILABLE" });
  const injected = new GrantsService({ provider, deployment: rpc.deployment, allowLocal: true });
  await injected.lookup(beneficiary); injected.close();
  assert.equal(await provider.send("eth_chainId", []), "0x4f25");
});
