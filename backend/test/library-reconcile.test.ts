import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { keccak256, type Log } from "ethers";
import libraryFixture from "../../docs/fixtures/library-v1.json" with { type: "json" };
import type { DeployedLibraryDeployment } from "@intracampus/network";
import { LibraryRepository } from "../src/modules/library/library.repository.ts";
import { LibraryReconciler } from "../src/modules/library/library.reconcile.ts";
import { HttpLibraryRpc } from "../src/modules/library/library.rpc.ts";

async function serveChainId(t: TestContext, chainId: string) {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body) as { id: string | number; method: string } | Array<{ id: string | number; method: string }>;
    const batch = Array.isArray(payload) ? payload : [payload];
    const responses = batch.map((call) => {
      methods.push(call.method);
      return { jsonrpc: "2.0", id: call.id, result: call.method === "eth_chainId" ? chainId : "0x0" };
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, methods };
}

test("RPC chain verification reads eth_chainId instead of trusting the configured static network", async (t) => {
  const endpoint = await serveChainId(t, "0x1");
  const rpc = new HttpLibraryRpc(endpoint.url);
  t.after(() => rpc.destroy());

  let network: Awaited<ReturnType<typeof rpc.getNetwork>>;
  try { network = await rpc.getNetwork(); }
  catch (error) { assert.fail(`RPC chain ID request failed (${JSON.stringify(endpoint.methods)}): ${String(error)}`); }

  assert.equal(network.chainId, 1n);
  assert.ok(endpoint.methods.includes("eth_chainId"));
});

test("canonicality checks are bounded per pass and resume from a durable cursor", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "library-reconcile-cursor-"));
  const path = join(directory, "library.sqlite");
  let repository = new LibraryRepository(path);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const student = "0x1111111111111111111111111111111111111111";
  const librarian = "0x2222222222222222222222222222222222222222";
  const bookId = `0x${"ab".repeat(32)}`;
  const escrow = "0x4444444444444444444444444444444444444444";
  const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  repository.seedDemo({ version: 1, books: [{ bookId, title: "Reconcile book", author: "Test", isbn: null,
    depositWei: "50000000000000000000", replacementPriceWei: "30000000000000000000",
    copies: [{ copyId: "copy-1", barcode: "LR-001" }] }],
    accounts: [{ wallet: student, role: "STUDENT" }, { wallet: librarian, role: "LIBRARIAN" }] });
  const requestId = hash(901);
  repository.createDepositRequest({ requestId, wallet: student, bookId, idempotencyKey: "canonicality-seed",
    createdAt: 100, chainTime: 100, holdAfterSeconds: 2_592_000 });

  const database = new DatabaseSync(path);
  const addEvent = database.prepare(`INSERT INTO chain_events(chain_id, contract_address, tx_hash, log_index, block_number,
    block_hash, event_name, request_id, payload_json, occurred_at) VALUES (20261, ?, ?, 0, 5, ?, 'DepositReceived', ?, '{}', 100)`);
  const addCanonicality = database.prepare(`INSERT INTO library_event_canonicality(event_id, status, checked_at, observed_block_hash)
    VALUES (?, 'CANONICAL', 100, ?)`);
  for (let index = 1; index <= 201; index++) {
    const inserted = addEvent.run(escrow, hash(1000 + index), hash(5), requestId);
    addCanonicality.run(Number(inserted.lastInsertRowid), hash(5));
  }
  database.close();

  const blockReads: Array<number | "latest"> = [];
  const rpc = {
    async getNetwork() { return { chainId: 20261n }; },
    async getBlock(tag: "latest" | number) {
      blockReads.push(tag);
      const number = tag === "latest" ? 500 : tag;
      return { number, timestamp: 1_800_000_000, hash: hash(number) };
    },
    async getLogs() { return []; },
    async getTransaction() { return null; },
    async getTransactionReceipt() { return null; },
    async getCode() { return "0x6000"; },
    async call() { return "0x"; },
  };
  const deployment = {
    schemaVersion: 1, status: "deployed", chainId: 20261, abiVersion: 1, environment: "local-anvil",
    verifiedAt: { blockNumber: 4, blockHash: hash(4) },
    escrow: { address: escrow, transactionHash: hash(1), blockNumber: 1, blockHash: hash(1),
      runtimeCodeHash: keccak256("0x6000"), abiVersion: 1, abi: libraryFixture.abi },
    roles: { deployer: librarian, administrator: librarian, librarian }, treasury: librarian,
    policy: libraryFixture.policy, books: [{ bookId, depositWei: "50000000000000000000", replacementPriceWei: "30000000000000000000", sealed: true }],
    seedTransactions: [],
  } as unknown as DeployedLibraryDeployment;
  const reconciler = new LibraryReconciler(repository, rpc as never, deployment,
    { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations: 1 }, () => 1_800_000_000);

  await reconciler.reconcile();
  assert.equal(repository.canonicalityCursor(), 200);
  assert.equal(blockReads.filter((tag) => tag === 5).length, 1, "only one bounded candidate batch is rechecked per pass");

  repository.close();
  repository = new LibraryRepository(path);
  assert.equal(repository.canonicalityCursor(), 200, "recheck progress survives process restart");
  const resumed = new LibraryReconciler(repository, rpc as never, deployment,
    { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations: 1 }, () => 1_800_000_000);
  await resumed.reconcile();
  assert.equal(repository.canonicalityCursor(), 201);
  assert.equal(blockReads.filter((tag) => tag === 5).length, 2, "the next pass checks the next event batch position");
});

test("dense log ranges subdivide and keep a contiguous restartable cursor", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "library-reconcile-dense-"));
  const path = join(directory, "library.sqlite");
  let repository = new LibraryRepository(path);
  t.after(() => { repository.close(); rmSync(directory, { recursive: true, force: true }); });
  const student = "0x1111111111111111111111111111111111111111";
  const librarian = "0x2222222222222222222222222222222222222222";
  const bookId = `0x${"ab".repeat(32)}`;
  const escrow = "0x4444444444444444444444444444444444444444";
  const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  repository.seedDemo({ version: 1, books: [{ bookId, title: "Dense events", author: "Test", isbn: null,
    depositWei: "50000000000000000000", replacementPriceWei: "30000000000000000000", copies: [{ copyId: "copy-1", barcode: "LR-001" }] }],
    accounts: [{ wallet: student, role: "STUDENT" }, { wallet: librarian, role: "LIBRARIAN" }] });
  const calls: Array<[number, number]> = [];
  let failRight = true;
  const denseLogs = Array.from({ length: 2001 }, (_, index) => ({ address: escrow, blockNumber: 1 + (index % 500), index,
    transactionIndex: 0, transactionHash: hash(1000 + index), blockHash: hash(1 + (index % 500)), data: "0x", topics: [], removed: false })) as unknown as Log[];
  const rpc = {
    async getNetwork() { return { chainId: 20261n }; },
    async getBlock(tag: "latest" | number) {
      const number = tag === "latest" ? 500 : tag;
      return { number, timestamp: 1_800_000_000, hash: hash(number) };
    },
    async getLogs(filter: { fromBlock?: number; toBlock?: number }) {
      const from = Number(filter.fromBlock), to = Number(filter.toBlock);
      calls.push([from, to]);
      if (from === 1 && to === 500) return denseLogs;
      if (from === 251 && to === 500 && failRight) { failRight = false; throw Error("temporary RPC failure"); }
      return [];
    },
    async getTransaction() { return null; }, async getTransactionReceipt() { return null; },
    async getCode() { return "0x6000"; }, async call() { return "0x"; },
  };
  const deployment = {
    schemaVersion: 1, status: "deployed", chainId: 20261, abiVersion: 1, environment: "local-anvil",
    verifiedAt: { blockNumber: 4, blockHash: hash(4) },
    escrow: { address: escrow, transactionHash: hash(1), blockNumber: 1, blockHash: hash(1),
      runtimeCodeHash: keccak256("0x6000"), abiVersion: 1, abi: libraryFixture.abi },
    roles: { deployer: librarian, administrator: librarian, librarian }, treasury: librarian,
    policy: libraryFixture.policy, books: [{ bookId, depositWei: "50000000000000000000", replacementPriceWei: "30000000000000000000", sealed: true }],
    seedTransactions: [],
  } as unknown as DeployedLibraryDeployment;
  const reconciler = new LibraryReconciler(repository, rpc as never, deployment,
    { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations: 1 }, () => 1_800_000_000);
  reconciler.verifierInstance.verify = async () => null;

  await assert.rejects(reconciler.reconcile(), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "RPC_UNAVAILABLE");
  assert.deepEqual(calls, [[1, 500], [1, 250], [251, 500]]);
  assert.equal(repository.reconcileState().cursorBlock, 250, "the left subrange commits before the right side fails");

  repository.close();
  repository = new LibraryRepository(path);
  const resumed = new LibraryReconciler(repository, rpc as never, deployment,
    { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations: 1 }, () => 1_800_000_000);
  resumed.verifierInstance.verify = async () => null;
  const result = await resumed.reconcile();
  assert.equal(result.caughtUp, true);
  assert.equal(repository.reconcileState().cursorBlock, 500, "restart resumes from the first uncommitted block");
  assert.deepEqual(calls.slice(3), [[251, 500]]);
});

test("canonicality reads 200 distinct blocks through at most two JSON-RPC batches", async (t) => {
  const blockReadBatchSizes: number[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body) as { id: string | number; method: string } | Array<{ id: string | number; method: string }>;
    const batch = Array.isArray(payload) ? payload : [payload];
    const blockReads = batch.filter((call) => call.method === "eth_getBlockByNumber").length;
    if (blockReads) blockReadBatchSizes.push(blockReads);
    const responses = batch.map((call) => ({ jsonrpc: "2.0", id: call.id,
      result: call.method === "eth_chainId" ? "0x4f25" : null }));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const rpc = new HttpLibraryRpc(`http://127.0.0.1:${address.port}`);
  t.after(() => rpc.destroy());

  const blocks = await Promise.all(Array.from({ length: 200 }, (_, index) => rpc.getBlock(index + 1)));
  assert.equal(blocks.length, 200);
  assert.equal(blockReadBatchSizes.reduce((sum, size) => sum + size, 0), 200);
  assert.ok(blockReadBatchSizes.length <= 2, `expected at most 2 HTTP batches, saw ${blockReadBatchSizes.length}`);
});
