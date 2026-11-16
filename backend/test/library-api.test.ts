import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { Interface, keccak256, Wallet, type Block, type Filter, type InterfaceAbi,
  type Log, type TransactionReceipt, type TransactionResponse } from "ethers";
import libraryFixture from "../../docs/fixtures/library-v1.json" with { type: "json" };
import type { DeployedLibraryDeployment } from "@intracampus/network";
import { createApp } from "../src/app.ts";
import { AuthRepository } from "../src/modules/auth/auth.repository.ts";
import { AuthService } from "../src/modules/auth/auth.service.ts";
import type { LibraryAuthConfig } from "../src/modules/auth/auth.config.ts";
import type { LibraryDemoSeed, LibraryVerifiedChainEvent } from "../src/modules/library/library.types.ts";
import { LibraryRepository } from "../src/modules/library/library.repository.ts";
import { LibraryService } from "../src/modules/library/library.service.ts";
import type { LibraryRpcClient } from "../src/modules/library/library.rpc.ts";
import type { GrantsService } from "../src/modules/grants/grants.service.ts";

const student = new Wallet(`0x${"11".repeat(32)}`);
const secondStudent = new Wallet(`0x${"22".repeat(32)}`);
const librarian = new Wallet(`0x${"33".repeat(32)}`);
const bookId = `0x${"ab".repeat(32)}`;
const depositWei = libraryFixture.policy.depositWei;
const replacementPriceWei = "30000000000000000000";
const now = 1_800_000_000;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const policy = {
  depositWei: libraryFixture.policy.depositWei,
  approvalWindowSeconds: libraryFixture.policy.approvalWindowSeconds,
  loanDurationSeconds: libraryFixture.policy.loanDurationSeconds,
  gracePeriodSeconds: libraryFixture.policy.gracePeriodSeconds,
  lateFeeIntervalSeconds: libraryFixture.policy.lateFeeIntervalSeconds,
  lateFeePerIntervalWei: libraryFixture.policy.lateFeePerIntervalWei,
  maxLateFeeWei: libraryFixture.policy.maxLateFeeWei,
  fullDepositRetentionAfterSeconds: libraryFixture.policy.fullDepositRetentionAfterSeconds,
};
const escrow = address(10);
const iface = new Interface(libraryFixture.abi as InterfaceAbi);
const authConfig: LibraryAuthConfig = {
  origin: "http://localhost:3000", domain: "localhost:3000", chainId: 20261,
  challengeTtlSeconds: 300, sessionTtlSeconds: 3600,
  challengeRateLimit: { maxRequests: 10, windowSeconds: 60 },
  verifyRateLimit: { maxRequests: 10, windowSeconds: 60 },
  trustedProxyAddresses: ["127.0.0.1", "::1"],
  cookieName: "library_session", secureCookie: false,
};

function deployment(): DeployedLibraryDeployment {
  return {
    schemaVersion: 1, status: "deployed", chainId: 20261, abiVersion: 1, environment: "local-anvil",
    verifiedAt: { blockNumber: 4, blockHash: hash(4) },
    escrow: { address: escrow, transactionHash: hash(1), blockNumber: 1, blockHash: hash(1),
      runtimeCodeHash: keccak256("0x6000"), abiVersion: 1, abi: libraryFixture.abi },
    roles: { deployer: address(11), administrator: address(12), librarian: librarian.address.toLowerCase() },
    treasury: address(13),
    policy,
    books: [{ bookId, depositWei, replacementPriceWei, sealed: true }],
    seedTransactions: [
      { type: "seedBookTerms", bookId, transactionHash: hash(2), blockNumber: 2, blockHash: hash(2) },
      { type: "sealBookTerms", bookId, transactionHash: hash(3), blockNumber: 3, blockHash: hash(3) },
    ],
  };
}

const seed: LibraryDemoSeed = {
  version: 1,
  books: [{ bookId, title: "Demo book", author: "Author", isbn: null, depositWei, replacementPriceWei,
    copies: [{ copyId: "copy-001", barcode: "LC-001" }] }],
  accounts: [
    { wallet: student.address, role: "STUDENT" },
    { wallet: secondStudent.address, role: "STUDENT" },
    { wallet: librarian.address, role: "LIBRARIAN" },
  ],
};

class FakeLibraryRpc implements LibraryRpcClient {
  chainId = 20261n;
  chainTime = now;
  headNumber = 500;
  available = true;
  transactions = new Map<string, TransactionResponse>();
  receipts = new Map<string, TransactionReceipt>();
  liveReplacementPriceWei = replacementPriceWei;
  termsReads = 0;
  failingBlockNumber: number | null = null;

  async getNetwork() {
    if (!this.available) throw new Error("rpc down");
    return { chainId: this.chainId };
  }
  async getBlock(tag: "latest" | number) {
    if (!this.available) throw new Error("rpc down");
    const number = tag === "latest" ? this.headNumber : tag;
    if (number === this.failingBlockNumber) throw new Error("block lookup failed");
    return { number, timestamp: this.chainTime, hash: hash(number) } as unknown as Block;
  }
  async getLogs(_filter: Filter): Promise<Log[]> {
    if (!this.available) throw new Error("rpc down");
    return [];
  }
  async getTransaction(txHash: string) { return this.transactions.get(txHash.toLowerCase()) ?? null; }
  async getTransactionReceipt(txHash: string) { return this.receipts.get(txHash.toLowerCase()) ?? null; }
  async getCode() { return "0x6000"; }
  async call() { this.termsReads++; return iface.encodeFunctionResult("bookTerms", [depositWei, this.liveReplacementPriceWei, true]); }
}

function setup(t: TestContext, minConfirmations = 1) {
  const repository = new LibraryRepository(":memory:");
  repository.seedDemo(seed);
  t.after(() => repository.close());
  const rpc = new FakeLibraryRpc();
  const library = deployment();
  const authService = new AuthService(new AuthRepository(repository), authConfig, () => rpc.chainTime);
  const libraryService = new LibraryService(repository, { deployment: { schemaVersion: 1, status: "deployed",
    chainId: 20261, abiVersion: 1, environment: "local-anvil", library }, allowLocal: true,
  chainFreshness: { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations }, rpc, now: () => now });
  const grants = { lookup: async () => ({ status: "verified", chainId: 20261, balanceWei: "1" }) } as unknown as GrantsService;
  const app = createApp(undefined, undefined, undefined, grants, authService, authConfig, libraryService);
  return { app, repository, rpc, library, authService, libraryService };
}

async function serve(t: TestContext, app: RequestListener): Promise<string> {
  const server = createServer(app).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, "listening");
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  return `http://127.0.0.1:${bound.port}`;
}

async function studentCookie(state: ReturnType<typeof setup>): Promise<string> {
  const challenge = state.authService.createChallenge({ wallet: student.address, remoteAddress: "127.0.0.1" });
  const signature = await student.signMessage(challenge.message);
  const session = state.authService.verifyChallenge({ challengeId: challenge.challengeId, signature, remoteAddress: "127.0.0.1" });
  return `library_session=${session.token}`;
}

async function librarianCookie(state: ReturnType<typeof setup>): Promise<string> {
  const challenge = state.authService.createChallenge({ wallet: librarian.address, remoteAddress: "127.0.0.1" });
  const signature = await librarian.signMessage(challenge.message);
  const session = state.authService.verifyChallenge({ challengeId: challenge.challengeId, signature, remoteAddress: "127.0.0.1" });
  return `library_session=${session.token}`;
}

function makeOverdueLoan(repository: LibraryRepository) {
  const requestId = hash(90);
  const depositedAt = 1_700_000_000;
  const approvedAt = depositedAt + 1;
  repository.createDepositRequest({ requestId, wallet: student.address, bookId, idempotencyKey: "historic-loan", createdAt: depositedAt - 1,
    chainTime: depositedAt - 1, holdAfterSeconds: 2_592_000 });
  const common = { chainId: 20261 as const, contractAddress: escrow, logIndex: 0, observedAt: now };
  const deposit: LibraryVerifiedChainEvent = { ...common, txHash: hash(91), blockNumber: 10, blockHash: hash(10),
    blockTimestamp: depositedAt, transactionFrom: student.address, eventName: "DepositReceived", requestId,
    borrower: student.address, bookId, amountWei: depositWei, depositedAt,
    approvalDeadline: depositedAt + policy.approvalWindowSeconds };
  repository.recordVerifiedChainEvents([deposit], 10, now, JSON.stringify(policy));
  const approval: LibraryVerifiedChainEvent = { ...common, txHash: hash(92), blockNumber: 11, blockHash: hash(11),
    blockTimestamp: approvedAt, transactionFrom: librarian.address, eventName: "LoanApproved", requestId,
    borrower: student.address, approvedAt, dueAt: approvedAt + policy.loanDurationSeconds, replacementPriceWei };
  repository.recordVerifiedChainEvents([approval], 11, now, JSON.stringify(policy));
  return requestId;
}

test("Library HTTP requires a session, validates same-origin creation, and keeps receipt-only success pending", async (t) => {
  const state = setup(t);
  const api = await serve(t, state.app);
  const cookie = await studentCookie(state);

  const unauthenticated = await fetch(`${api}/api/library/books`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("cache-control"), "no-store");

  const booksResponse = await fetch(`${api}/api/library/books`, { headers: { cookie } });
  assert.equal(booksResponse.status, 200);
  assert.equal((await booksResponse.json())[0].copiesAvailable, 1);

  const anonymousGrant = await fetch(`${api}/api/grants/${student.address}`);
  assert.equal(anonymousGrant.status, 401);
  assert.equal((await anonymousGrant.json()).error.code, "UNAUTHENTICATED");
  const foreignGrant = await fetch(`${api}/api/grants/${secondStudent.address}`, { headers: { cookie } });
  assert.equal(foreignGrant.status, 403);
  assert.equal((await foreignGrant.json()).error.code, "FORBIDDEN");

  const invalid = await fetch(`${api}/api/library/requests`, { method: "POST", headers: {
    cookie, origin: authConfig.origin, "content-type": "application/json" },
    body: JSON.stringify({ bookId, idempotencyKey: "request-1", wallet: secondStudent.address, role: "LIBRARIAN" }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "VALIDATION_ERROR");

  const requestBody = { bookId, idempotencyKey: "request-1" };
  const created = await fetch(`${api}/api/library/requests`, { method: "POST", headers: {
    cookie, origin: authConfig.origin, "content-type": "application/json" }, body: JSON.stringify(requestBody) });
  assert.equal(created.status, 201);
  const request = await created.json();
  assert.equal(request.status, "AWAITING_DEPOSIT");
  assert.equal(request.depositIntent.valueWei, depositWei);
  assert.equal(state.repository.listBooks()[0].copiesAvailable, 1, "a wallet intent must not reserve a copy");

  const repeated = await fetch(`${api}/api/library/requests`, { method: "POST", headers: {
    cookie, origin: authConfig.origin, "content-type": "application/json" }, body: JSON.stringify(requestBody) });
  assert.equal((await repeated.json()).requestId, request.requestId);

  const txHash = hash(93);
  state.rpc.transactions.set(txHash, { hash: txHash, to: escrow, from: student.address,
    data: iface.encodeFunctionData("deposit", [request.requestId, bookId]), value: BigInt(depositWei) } as unknown as TransactionResponse);
  state.rpc.receipts.set(txHash, { hash: txHash, status: 1, blockNumber: 501, blockHash: hash(501), logs: [] } as unknown as TransactionReceipt);
  const submitted = await fetch(`${api}/api/library/requests/${request.requestId}/transactions`, { method: "POST", headers: {
    cookie, origin: authConfig.origin, "content-type": "application/json" }, body: JSON.stringify({ action: "deposit", txHash }) });
  assert.equal(submitted.status, 202);
  const transaction = await submitted.json();
  assert.equal(transaction.transaction.status, "SUBMITTED");
  assert.equal(transaction.request.status, "AWAITING_DEPOSIT", "a successful receipt without a verified lifecycle event is not a deposit");
});

test("request creation fails closed when sealed live book terms differ from the manifest and SQLite seed", async (t) => {
  const state = setup(t);
  state.rpc.liveReplacementPriceWei = "99000000000000000000";
  const api = await serve(t, state.app);
  const cookie = await studentCookie(state);
  const response = await fetch(`${api}/api/library/requests`, { method: "POST", headers: {
    cookie, origin: authConfig.origin, "content-type": "application/json" },
    body: JSON.stringify({ bookId, idempotencyKey: "untrusted-terms" }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "CONFIGURATION_ERROR");
  assert.equal(state.rpc.termsReads, 1, "the configured safe block is read before issuing a deposit intent");
  assert.deepEqual(state.repository.listRequests(student.address), []);
});

test("malformed Library request and settlement inputs return validation errors", async (t) => {
  const state = setup(t);
  const requestId = makeOverdueLoan(state.repository);
  const returnedAt = 1_700_100_000;
  state.repository.recordVerifiedChainEvents([{
    chainId: 20261, contractAddress: escrow, txHash: hash(99), logIndex: 0, blockNumber: 12, blockHash: hash(12),
    blockTimestamp: returnedAt, transactionFrom: librarian.address, observedAt: returnedAt + 1,
    eventName: "PhysicalReturnConfirmed", requestId, borrower: student.address, returnedAt,
  }], 12, returnedAt + 1, JSON.stringify(policy));
  const api = await serve(t, state.app);
  const cookie = await studentCookie(state);
  const malformedRequest = await fetch(`${api}/api/library/requests/not-a-bytes32-id`, { headers: { cookie } });
  assert.equal(malformedRequest.status, 400);
  assert.equal((await malformedRequest.json()).error.code, "VALIDATION_ERROR");

  const librarianAuth = await librarianCookie(state);
  const malformedLoan = await fetch(`${api}/api/library/loans/not-a-bytes32-id/settlement-intents`, { method: "POST", headers: {
    cookie: librarianAuth, origin: authConfig.origin, "content-type": "application/json" },
    body: JSON.stringify({ outcome: "LOST", reason: "Demo loss" }) });
  assert.equal(malformedLoan.status, 400);
  assert.equal((await malformedLoan.json()).error.code, "VALIDATION_ERROR");

  for (const repairRequestedWei of ["01", "-1", "1.1", "1e20", (2n ** 256n).toString()]) {
    const response = await fetch(`${api}/api/library/loans/${requestId}/settlement-intents`, { method: "POST", headers: {
      cookie: librarianAuth, origin: authConfig.origin, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "RETURNED", condition: "GOOD", reason: "No damage", repairRequestedWei }) });
    assert.equal(response.status, 400, `repair amount ${repairRequestedWei} should be rejected`);
    assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
  }
});

test("a failed canonical block lookup for a reverted receipt returns retryable RPC_UNAVAILABLE", async (t) => {
  const state = setup(t);
  const api = await serve(t, state.app);
  const cookie = await studentCookie(state);
  const account = { wallet: student.address as `0x${string}`, role: "STUDENT" as const };
  const { request } = await state.libraryService.createRequest({ account, bookId, idempotencyKey: "reverted-block-read" });
  const txHash = hash(197);
  state.rpc.transactions.set(txHash, { hash: txHash, to: escrow, from: student.address,
    data: iface.encodeFunctionData("deposit", [request.requestId, bookId]), value: BigInt(depositWei) } as unknown as TransactionResponse);
  state.rpc.receipts.set(txHash, { hash: txHash, status: 0, blockNumber: 499, blockHash: hash(499), logs: [] } as unknown as TransactionReceipt);
  state.rpc.failingBlockNumber = 499;

  const response = await fetch(`${api}/api/library/requests/${request.requestId}/transactions`, { method: "POST", headers: {
    cookie, origin: authConfig.origin, "content-type": "application/json" }, body: JSON.stringify({ action: "deposit", txHash }) });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "2");
  const error = (await response.json()).error;
  assert.equal(error.code, "RPC_UNAVAILABLE");
  assert.equal(error.retryable, true);
  assert.equal(state.repository.getTransaction(request.requestId, "deposit")?.status, "SUBMITTED",
    "a missing canonical block read does not misclassify the receipt as reverted");
});

test("transaction submission is idempotent when reconciliation sees the mined event first", async (t) => {
  const state = setup(t);
  const account = { wallet: student.address as `0x${string}`, role: "STUDENT" as const };
  const { request } = await state.libraryService.createRequest({ account, bookId, idempotencyKey: "mined-before-submit" });
  const txHash = hash(198);
  state.repository.recordVerifiedChainEvents([{
    chainId: 20261,
    contractAddress: escrow,
    txHash,
    logIndex: 0,
    blockNumber: 500,
    blockHash: hash(500),
    blockTimestamp: now,
    transactionFrom: student.address,
    observedAt: now,
    eventName: "DepositReceived",
    requestId: request.requestId,
    borrower: student.address,
    bookId,
    amountWei: depositWei,
    depositedAt: now,
    approvalDeadline: now + policy.approvalWindowSeconds,
  }], 500, now, JSON.stringify(policy));
  assert.equal(state.repository.getRequest(request.requestId)?.status, "PENDING_APPROVAL");
  state.rpc.transactions.set(txHash, { hash: txHash, to: escrow, from: student.address,
    data: iface.encodeFunctionData("deposit", [request.requestId, bookId]), value: BigInt(depositWei) } as unknown as TransactionResponse);

  const submitted = await state.libraryService.submitTransaction(account, request.requestId, { action: "deposit", txHash });
  assert.equal(submitted.request.status, "PENDING_APPROVAL");
  assert.equal(submitted.transaction?.txHash, txHash);
  assert.equal(submitted.transaction?.status, "CONFIRMED");
});

function seedLibrarianRefundAfterNoCopy(repository: LibraryRepository) {
  const reservedId = hash(201), requestId = hash(202);
  const depositedAt = now - policy.approvalWindowSeconds - 2;
  const common = { chainId: 20261 as const, contractAddress: escrow, logIndex: 0, observedAt: now };
  const deposits = [
    { id: reservedId, borrower: secondStudent.address, block: 490 },
    { id: requestId, borrower: student.address, block: 491 },
  ];
  for (const entry of deposits) {
    repository.createDepositRequest({ requestId: entry.id, wallet: entry.borrower, bookId, idempotencyKey: entry.id,
      createdAt: depositedAt - 1, chainTime: depositedAt - 1, holdAfterSeconds: policy.fullDepositRetentionAfterSeconds });
  }
  repository.recordVerifiedChainEvents(deposits.map(entry => ({
    ...common, txHash: hash(entry.block + 100), blockNumber: entry.block, blockHash: hash(entry.block),
    blockTimestamp: depositedAt, transactionFrom: entry.borrower, eventName: "DepositReceived" as const,
    requestId: entry.id, borrower: entry.borrower, bookId, amountWei: depositWei, depositedAt,
    approvalDeadline: depositedAt + policy.approvalWindowSeconds,
  })), 491, now, JSON.stringify(policy));
  assert.equal(repository.getRequest(requestId)?.status, "REJECTED_NO_COPY");
  const rejectHash = hash(592);
  repository.recordVerifiedChainEvents([{
    ...common, txHash: rejectHash, blockNumber: 492, blockHash: hash(492), blockTimestamp: now - 1,
    transactionFrom: librarian.address, eventName: "RequestRejected", requestId, borrower: student.address, refundWei: depositWei,
  }], 492, now, JSON.stringify(policy));
  return { requestId, rejectHash };
}

test("first tracking records the borrower's canonical revert after the librarian already refunded the deposit", async (t) => {
  const state = setup(t);
  const { requestId, rejectHash } = seedLibrarianRefundAfterNoCopy(state.repository);
  const api = await serve(t, state.app);
  const cookie = await studentCookie(state);
  const txHash = hash(601);
  state.rpc.transactions.set(txHash, { hash: txHash, to: escrow, from: student.address,
    data: iface.encodeFunctionData("claimExpiredRefund", [requestId]), value: 0n } as unknown as TransactionResponse);
  state.rpc.receipts.set(txHash, { hash: txHash, status: 0, blockNumber: 499, blockHash: hash(499), logs: [] } as unknown as TransactionReceipt);
  const track = () => fetch(`${api}/api/library/requests/${requestId}/transactions`, { method: "POST",
    headers: { cookie, origin: authConfig.origin, "content-type": "application/json" }, body: JSON.stringify({ action: "refund", txHash }) });

  const first = await track();
  assert.equal(first.status, 200, await first.clone().text());
  const result = await first.json();
  assert.equal(result.request.status, "REJECTED");
  assert.equal(result.request.refundStatus, "REFUNDED");
  assert.equal(result.transaction.status, "REVERTED");
  assert.equal(result.transaction.txHash, txHash);
  assert.equal(result.transaction.proof, null);
  assert.equal(result.request.transactions.find((tx: { action: string }) => tx.action === "reject")?.txHash, rejectHash);
  const again = await track();
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), result);
  assert.equal(state.repository.getTransaction(requestId, "refund")?.blockHash, hash(499));
});

test("closed refunds reject unrelated or unconfirmed attempts until the exact revert reaches the safe head", async (t) => {
  const state = setup(t, 2);
  const { requestId } = seedLibrarianRefundAfterNoCopy(state.repository);
  const account = { wallet: student.address as `0x${string}`, role: "STUDENT" as const };
  const txHash = hash(602);
  const transaction = { hash: txHash, to: escrow, from: student.address,
    data: iface.encodeFunctionData("claimExpiredRefund", [requestId]), value: 0n };
  const receipt = { hash: txHash, status: 0, blockNumber: 500, blockHash: hash(500), logs: [] };
  const track = () => state.libraryService.submitTransaction(account, requestId, { action: "refund", txHash });

  await assert.rejects(track, /CONFLICT/);
  state.rpc.transactions.set(txHash, transaction as unknown as TransactionResponse);
  await assert.rejects(track, /CONFLICT/);
  state.rpc.receipts.set(txHash, receipt as unknown as TransactionReceipt);
  await assert.rejects(track, /CONFLICT/);
  assert.equal(state.repository.getTransaction(requestId, "refund"), undefined);
  state.rpc.headNumber = 501;
  state.rpc.transactions.set(txHash, { ...transaction, from: secondStudent.address } as unknown as TransactionResponse);
  await assert.rejects(track, /FORBIDDEN/);
  state.rpc.transactions.set(txHash, { ...transaction, hash: hash(603) } as unknown as TransactionResponse);
  await assert.rejects(track, /CONFLICT/);
  state.rpc.transactions.set(txHash, transaction as unknown as TransactionResponse);
  for (const invalidReceipt of [{ ...receipt, hash: hash(603) }, { ...receipt, blockHash: hash(504) }, { ...receipt, status: 1 }]) {
    state.rpc.receipts.set(txHash, invalidReceipt as unknown as TransactionReceipt);
    await assert.rejects(track, /CONFLICT/);
  }
  assert.equal(state.repository.getTransaction(requestId, "refund"), undefined);
  state.rpc.receipts.set(txHash, receipt as unknown as TransactionReceipt);
  assert.equal((await track()).transaction?.status, "REVERTED");
});

test("librarian queue and reject action include deposited requests that had no copy to assign", async (t) => {
  const state = setup(t);
  const firstRequestId = hash(95), noCopyRequestId = hash(96);
  for (const [requestId, borrower, byte] of [[firstRequestId, student.address, 97], [noCopyRequestId, secondStudent.address, 98]] as const) {
    state.repository.createDepositRequest({ requestId, wallet: borrower, bookId, idempotencyKey: `queue-${byte}`,
      createdAt: now - 1, chainTime: now - 1, holdAfterSeconds: 2_592_000 });
  }
  for (const [requestId, borrower, byte] of [[firstRequestId, student.address, 97], [noCopyRequestId, secondStudent.address, 98]] as const) {
    state.repository.recordVerifiedDeposit({ requestId, borrower, bookId, depositWei, approvalDeadline: now + 86_400,
      chainId: 20261, contractAddress: escrow, txHash: hash(byte), logIndex: 0, blockNumber: 10 + byte,
      blockHash: hash(10 + byte), eventName: "DepositReceived", occurredAt: now - 1 });
  }
  assert.equal(state.repository.getRequest(noCopyRequestId)?.status, "REJECTED_NO_COPY");
  const librarianAccount = { wallet: librarian.address as `0x${string}`, role: "LIBRARIAN" as const };
  const queue = await state.libraryService.listRequests(librarianAccount, true);
  assert.ok(queue.some((request) => request.requestId === noCopyRequestId && request.status === "REJECTED_NO_COPY"));

  const txHash = hash(99);
  state.rpc.transactions.set(txHash, { hash: txHash, to: escrow, from: librarian.address,
    data: iface.encodeFunctionData("reject", [noCopyRequestId]), value: BigInt(0) } as unknown as TransactionResponse);
  const result = await state.libraryService.submitTransaction(librarianAccount, noCopyRequestId, { action: "reject", txHash });
  assert.equal(result.transaction?.status, "SUBMITTED");
  assert.equal(result.request.status, "REJECTED_NO_COPY", "the on-chain refund receipt remains authoritative");
});

test("overdue hold blocks new Library and grants calls while account and return recovery stay available", async (t) => {
  const state = setup(t);
  const retryRequestId = hash(89);
  state.repository.createDepositRequest({ requestId: retryRequestId, wallet: student.address, bookId,
    idempotencyKey: "held-idempotent-retry", createdAt: now - 1, chainTime: now - 1, holdAfterSeconds: 2_592_000 });
  const requestId = makeOverdueLoan(state.repository);
  const api = await serve(t, state.app);
  const cookie = await studentCookie(state);
  const headers = { cookie, origin: authConfig.origin, "content-type": "application/json" };

  const status = await fetch(`${api}/api/library/account-status`, { headers: { cookie } });
  assert.equal(status.status, 200);
  const account = await status.json();
  assert.equal(account.held, true);
  assert.deepEqual(account.blockingLoanIds, [requestId]);

  const repeated = await fetch(`${api}/api/library/requests`, { method: "POST", headers,
    body: JSON.stringify({ bookId, idempotencyKey: "held-idempotent-retry" }) });
  assert.equal(repeated.status, 201, "a retry returns the original request even if the account became held later");
  const repeatedRequest = await repeated.json();
  assert.equal(repeatedRequest.requestId, retryRequestId);
  assert.equal(repeatedRequest.depositIntent, null, "a held retry preserves request identity but cannot offer a new wallet deposit");

  const heldDetail = await fetch(`${api}/api/library/requests/${retryRequestId}`, { headers: { cookie } });
  assert.equal(heldDetail.status, 200);
  assert.equal((await heldDetail.json()).depositIntent, null, "request detail must not reissue a deposit intent while held");
  const heldList = await fetch(`${api}/api/library/requests`, { headers: { cookie } });
  assert.equal(heldList.status, 200);
  const listedRetry = (await heldList.json()).find((request: { requestId: string }) => request.requestId === retryRequestId);
  assert.equal(listedRetry?.depositIntent, null, "request history must not reissue a deposit intent while held");
  const staffCookie = await librarianCookie(state);
  const staffDetail = await fetch(`${api}/api/library/requests/${retryRequestId}`, { headers: { cookie: staffCookie } });
  assert.equal(staffDetail.status, 200);
  assert.equal((await staffDetail.json()).depositIntent, null, "staff detail must not reissue a held borrower's deposit intent");

  const create = await fetch(`${api}/api/library/requests`, { method: "POST", headers,
    body: JSON.stringify({ bookId, idempotencyKey: "held-request" }) });
  assert.equal(create.status, 403);
  assert.equal((await create.json()).error.code, "FORBIDDEN");

  const grants = await fetch(`${api}/api/grants/${student.address}`, { headers: { cookie } });
  assert.equal(grants.status, 403);
  assert.equal((await grants.json()).error.code, "FORBIDDEN");
  const grantRecovery = await fetch(`${api}/api/grants/${student.address}?txHash=${hash(188)}`, { headers: { cookie } });
  assert.equal(grantRecovery.status, 200, "a held student can reconcile their own previously sent grant transaction");

  const returned = await fetch(`${api}/api/library/loans/${requestId}/return-requests`, { method: "POST", headers,
    body: "{}" });
  assert.equal(returned.status, 201);
  assert.equal((await returned.json()).status, "RETURN_REQUESTED");
});

test("chain mismatch and RPC loss return honest retryable errors", async (t) => {
  const state = setup(t);
  const api = await serve(t, state.app);
  const cookie = await studentCookie(state);
  state.rpc.chainId = 1n;

  let response = await fetch(`${api}/api/library/books`, { headers: { cookie } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.deepEqual((await response.json()).error, { code: "WRONG_CHAIN",
    message: "The configured network does not match the required chain.", retryable: true });
  const unavailableGrant = await fetch(`${api}/api/grants/${student.address}`, { headers: { cookie } });
  assert.equal(unavailableGrant.status, 503);
  assert.equal(unavailableGrant.headers.get("retry-after"), "2");
  assert.equal((await unavailableGrant.json()).error.code, "WRONG_CHAIN");

  state.rpc.chainId = 20261n;
  state.rpc.chainTime = now - 301;
  response = await fetch(`${api}/api/library/books`, { headers: { cookie } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.equal((await response.json()).error.code, "STALE_CHAIN_STATE");

  state.rpc.chainTime = now + 31;
  response = await fetch(`${api}/api/library/books`, { headers: { cookie } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "2");
  assert.equal((await response.json()).error.code, "STALE_CHAIN_STATE");

  state.rpc.chainTime = now;
  state.rpc.available = false;
  response = await fetch(`${api}/api/library/books`, { headers: { cookie } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "RPC_UNAVAILABLE");
});
