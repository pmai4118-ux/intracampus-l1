import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { LibraryRepository, applyLibraryMigrations } from "../src/modules/library/library.repository.ts";
import { libraryMigrations } from "../src/modules/library/library.migrations.ts";
import type { LibraryBookSeed, LibraryVerifiedChainEvent } from "../src/modules/library/library.types.ts";

const studentA = "0x1111111111111111111111111111111111111111";
const studentB = "0x2222222222222222222222222222222222222222";
const librarian = "0x3333333333333333333333333333333333333333";
const bookId = `0x${"ab".repeat(32)}`;
const depositWei = "50000000000000000000";
const priceWei = "30000000000000000000";

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "library-repository-"));
  const path = join(directory, "library.sqlite");
  return {
    directory,
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    seed: {
      version: 1,
      books: [{ bookId, title: "Demo book", author: "Demo author", isbn: null, depositWei,
        replacementPriceWei: priceWei, copies: [{ copyId: "copy-001", barcode: "LC-001" }] }] satisfies LibraryBookSeed[],
      accounts: [
        { wallet: studentA, role: "STUDENT" as const },
        { wallet: studentB, role: "STUDENT" as const },
        { wallet: librarian, role: "LIBRARIAN" as const },
      ],
    },
  };
}

function deposit(requestId: string, borrower: string, txByte: string, logIndex = 0) {
  return {
    requestId,
    borrower,
    bookId,
    depositWei,
    approvalDeadline: 1_800_000_000,
    chainId: 20261 as const,
    contractAddress: "0x4444444444444444444444444444444444444444",
    txHash: `0x${txByte.repeat(32)}`,
    logIndex,
    blockNumber: 123,
    blockHash: `0x${"cd".repeat(32)}`,
    eventName: "DepositReceived" as const,
    occurredAt: 1_799_913_600,
  };
}

function recordDepositInWorker(databasePath: string, input: ReturnType<typeof deposit>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.repositoryUrl).then(({ LibraryRepository }) => {
        const repository = new LibraryRepository(workerData.databasePath);
        try { parentPort.postMessage({ value: repository.recordVerifiedDeposit(workerData.input) }); }
        catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
        finally { repository.close(); }
      }).catch((error) => parentPort.postMessage({ error: String(error) }));
    `, {
      eval: true,
      execArgv: [],
      workerData: { databasePath, input, repositoryUrl: new URL("../src/modules/library/library.repository.ts", import.meta.url).href },
    });
    worker.once("message", (result: { value?: unknown; error?: string }) => {
      void worker.terminate();
      if (result.error) reject(new Error(result.error));
      else resolve(result.value);
    });
    worker.once("error", reject);
  });
}

function consumeChallengeInWorker(databasePath: string, tokenByte: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.repositoryUrl).then(({ LibraryRepository }) => {
        const repository = new LibraryRepository(workerData.databasePath);
        try { parentPort.postMessage({ value: repository.consumeChallengeAndCreateSession({
          challengeId: 'race-challenge', tokenHash: workerData.tokenHash, now: 199, expiresAt: 300,
        }) }); }
        catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
        finally { repository.close(); }
      }).catch((error) => parentPort.postMessage({ error: String(error) }));
    `, {
      eval: true,
      execArgv: [],
      workerData: { databasePath, tokenHash: tokenByte.repeat(64), repositoryUrl: new URL("../src/modules/library/library.repository.ts", import.meta.url).href },
    });
    worker.once("message", (result: { value?: unknown; error?: string }) => {
      void worker.terminate();
      if (result.error) reject(new Error(result.error));
      else resolve(result.value);
    });
    worker.once("error", reject);
  });
}

function recordActiveLoan(repository: LibraryRepository, requestId: string, block: number, time: number): void {
  const contractAddress = "0x4444444444444444444444444444444444444444";
  const approvalDeadline = time + 86_400;
  repository.createDepositRequest({ requestId, wallet: studentA, bookId, idempotencyKey: requestId,
    createdAt: time - 1, chainTime: time - 1, holdAfterSeconds: 2_592_000 });
  repository.recordVerifiedChainEvents([{
    chainId: 20261, contractAddress, txHash: `0x${block.toString(16).padStart(64, "0")}`, logIndex: 0, blockNumber: block,
    blockHash: `0x${(block + 10_000).toString(16).padStart(64, "0")}`, blockTimestamp: time, transactionFrom: studentA, observedAt: time + 10,
    eventName: "DepositReceived", requestId, borrower: studentA, bookId, amountWei: depositWei,
    depositedAt: time, approvalDeadline,
  }], block, time + 10, "{}");
  repository.recordVerifiedChainEvents([{
    chainId: 20261, contractAddress, txHash: `0x${(block + 1).toString(16).padStart(64, "0")}`, logIndex: 0, blockNumber: block + 1,
    blockHash: `0x${(block + 10_001).toString(16).padStart(64, "0")}`, blockTimestamp: approvalDeadline - 1, transactionFrom: librarian,
    observedAt: approvalDeadline + 10, eventName: "LoanApproved", requestId, borrower: studentA,
    approvedAt: approvalDeadline - 1, dueAt: approvalDeadline - 1 + 1_209_600, replacementPriceWei: priceWei,
  }], block + 1, approvalDeadline + 10, "{}");
}

function initializeDatabaseInWorker(databasePath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.repositoryUrl).then(({ LibraryRepository }) => {
        const repository = new LibraryRepository(workerData.databasePath);
        const version = repository.schemaVersion();
        repository.close();
        parentPort.postMessage({ version });
      }).catch((error) => parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }));
    `, {
      eval: true,
      execArgv: [],
      workerData: { databasePath, repositoryUrl: new URL("../src/modules/library/library.repository.ts", import.meta.url).href },
    });
    worker.once("message", (result: { version?: number; error?: string }) => {
      void worker.terminate();
      if (result.error) reject(new Error(result.error));
      else resolve(result.version);
    });
    worker.once("error", reject);
  });
}

test("migrates a new DB, reruns safely, and preserves rows and schema after restart", (t) => {
  const env = setup();
  t.after(env.cleanup);
  let repository = new LibraryRepository(env.path);
  assert.equal(repository.schemaVersion(), 6);
  assert.deepEqual(repository.sqliteSettings(), { foreignKeys: 1, journalMode: "wal", synchronous: 2, busyTimeoutMs: 5000 });
  assert.equal(repository.seedDemo(env.seed), "inserted");
  repository.close();

  repository = new LibraryRepository(env.path);
  assert.equal(repository.schemaVersion(), 6);
  assert.equal(repository.seedDemo(env.seed), "unchanged");
  assert.deepEqual(repository.listBooks()[0], {
    bookId, title: "Demo book", author: "Demo author", isbn: null, depositWei, replacementPriceWei: priceWei,
    copiesTotal: 1, copiesAvailable: 1,
  });
  assert.equal(repository.accountForWallet(studentA)?.role, "STUDENT");
  repository.close();

  const db = new DatabaseSync(env.path);
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA synchronous").get()?.synchronous, 2);
  db.close();
});

test("canonical unmatched deposits survive restart and replay without allocating a copy", t => {
  const env = setup();
  let repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  const requestId = `0x${"71".repeat(32)}`;
  repository.createDepositRequest({ requestId, wallet: studentA, bookId, idempotencyKey: "unmatched", createdAt: 99,
    chainTime: 99, holdAfterSeconds: 2_592_000 });
  const event: LibraryVerifiedChainEvent = { chainId: 20261, contractAddress: "0x4444444444444444444444444444444444444444",
    txHash: `0x${"72".repeat(32)}`, logIndex: 0, blockNumber: 1, blockHash: `0x${"73".repeat(32)}`,
    blockTimestamp: 100, transactionFrom: studentB, observedAt: 101, eventName: "DepositReceived", requestId,
    borrower: studentB, bookId, amountWei: depositWei, depositedAt: 100, approvalDeadline: 86500 };
  repository.recordVerifiedChainEvents([event], 1, 101, "{}");
  repository.close();
  repository = new LibraryRepository(env.path);
  assert.equal(repository.unmatchedDeposits()[0].borrower, studentB);
  assert.equal(repository.recordVerifiedChainEvents([event], 1, 102, "{}").duplicates, 1);
  assert.equal(repository.listBooks()[0].copiesAvailable, 1);
  assert.equal(repository.getRequest(requestId)?.copyId, null);
});

test("migration failure rolls back its schema and version", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => applyLibraryMigrations(db, [{ version: 1,
      sql: "CREATE TABLE partial_migration(id INTEGER PRIMARY KEY); THIS IS INVALID SQL;" }]), /syntax|error/i);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial_migration'").get(), undefined);
  } finally { db.close(); }
});

test("version 5 backfills existing transaction state into attempt history", (t) => {
  const env = setup();
  const requestId = `0x${"71".repeat(32)}`;
  const txHash = `0x${"72".repeat(32)}`;
  const blockHash = `0x${"73".repeat(32)}`;
  const db = new DatabaseSync(env.path);
  try {
    applyLibraryMigrations(db, libraryMigrations.slice(0, 4));
    db.prepare("INSERT INTO accounts(wallet, role, created_at) VALUES (?, 'STUDENT', 1)").run(studentA);
    const accountId = Number(db.prepare("SELECT account_id FROM accounts WHERE wallet = ?").get(studentA)?.account_id);
    db.prepare(`INSERT INTO books(book_id, title, author, replacement_price_wei, deposit_wei, seed_version, created_at)
      VALUES (?, 'Migrated', 'Test', ?, ?, 1, 1)`).run(bookId, priceWei, depositWei);
    db.prepare(`INSERT INTO borrow_requests(request_id, account_id, book_id, idempotency_key, status, refund_status, created_at, updated_at)
      VALUES (?, ?, ?, 'migration-attempt', 'AWAITING_DEPOSIT', 'NONE', 1, 1)`).run(requestId, accountId, bookId);
    db.prepare(`INSERT INTO library_transactions(request_id, action, tx_hash, submitted_at, status, block_number, block_hash)
      VALUES (?, 'deposit', ?, 2, 'REVERTED', 5, ?)`).run(requestId, txHash, blockHash);
  } finally { db.close(); }

  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  assert.equal(repository.schemaVersion(), 6);
  const migrated = new DatabaseSync(env.path);
  try {
    const attempt = migrated.prepare(`SELECT tx_hash, request_id, action, status, block_number, block_hash
      FROM library_transaction_attempts WHERE tx_hash = ?`).get(txHash);
    assert.deepEqual(Object.assign({}, attempt), {
      tx_hash: txHash, request_id: requestId, action: "deposit", status: "REVERTED", block_number: 5, block_hash: blockHash,
    });
  } finally { migrated.close(); }
});

test("two independent startup processes migrate a new file database once", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const versions = await Promise.all([
    initializeDatabaseInWorker(env.path),
    initializeDatabaseInWorker(env.path),
  ]);
  assert.deepEqual(versions, [6, 6]);
  const repository = new LibraryRepository(env.path);
  assert.equal(repository.schemaVersion(), 6);
  const db = new DatabaseSync(env.path);
  try {
    for (const table of ["library_reconcile_state", "library_transactions", "library_transaction_attempts", "library_event_canonicality"]) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), table);
    }
    assert.ok(db.prepare("PRAGMA table_info(library_transactions)").all().some((column) => column.name === "settlement_intent_id"));
    assert.ok(db.prepare("PRAGMA table_info(library_reconcile_state)").all().some((column) => column.name === "pending_transaction_cursor"));
    assert.ok(db.prepare("PRAGMA table_info(settlements)").all().some((column) => column.name === "settlement_intent_id"));
    assert.deepEqual(Object.assign({}, db.prepare("SELECT cursor_block, health FROM library_reconcile_state WHERE singleton = 1").get()),
      { cursor_block: 0, health: "HEALTHY" });
  } finally { db.close(); }
  repository.close();
});

test("demo seeds are immutable, idempotent, and reject mismatched sealed terms", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  assert.equal(repository.seedDemo(env.seed), "inserted");
  assert.equal(repository.seedDemo(env.seed), "unchanged");
  assert.throws(() => repository.seedDemo({ ...env.seed, books: [{ ...env.seed.books[0], replacementPriceWei: "1" }] }),
    { message: "LIBRARY_SEED_CONFLICT" });
  const badDepositSeed = { ...env.seed, books: [{ ...env.seed.books[0], depositWei: "1" }] };
  const numericDepositSeed = { ...env.seed, books: [{ ...env.seed.books[0], depositWei: 1 as unknown as string }] };
  const emptyRepository = new LibraryRepository(join(env.directory, "invalid.sqlite"));
  assert.throws(() => emptyRepository.seedDemo(badDepositSeed), { message: "INVALID_LIBRARY_DEPOSIT" });
  assert.throws(() => emptyRepository.seedDemo(numericDepositSeed), { message: "INVALID_LIBRARY_WEI" });
  assert.equal(emptyRepository.listBooks().length, 0);
  emptyRepository.close();
  assert.equal(repository.listBooks()[0].replacementPriceWei, priceWei);
  const db = new DatabaseSync(env.path);
  try {
    assert.throws(() => db.prepare("UPDATE books SET replacement_price_wei = '1' WHERE book_id = ?").run(bookId), /LIBRARY_BOOK_TERMS_IMMUTABLE/);
    assert.throws(() => db.prepare("UPDATE accounts SET role = 'LIBRARIAN' WHERE wallet = ?").run(studentA), /LIBRARY_ACCOUNT_IDENTITY_IMMUTABLE/);
  } finally { db.close(); }
});

test("demo seed accepts metadata beyond undocumented field-length caps", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  const book = { ...env.seed.books[0], title: "T".repeat(301), author: "A".repeat(201), isbn: "I".repeat(33),
    copies: [{ copyId: "C".repeat(101), barcode: "B".repeat(101) }] };
  assert.equal(repository.seedDemo({ ...env.seed, books: [book] }), "inserted");
  assert.equal(repository.listBooks()[0].title, book.title);
});

test("simultaneous independent connections assign the last copy to only one deposited request", async (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  repository.seedDemo(env.seed);
  const a = `0x${"01".repeat(32)}`;
  const b = `0x${"02".repeat(32)}`;
  repository.createDepositRequest({ requestId: a, wallet: studentA, bookId, idempotencyKey: "req-a", createdAt: 1_799_900_000, chainTime: 1_799_900_000, holdAfterSeconds: 2_592_000 });
  repository.createDepositRequest({ requestId: b, wallet: studentB, bookId, idempotencyKey: "req-b", createdAt: 1_799_900_000, chainTime: 1_799_900_000, holdAfterSeconds: 2_592_000 });
  repository.close();

  const results = await Promise.all([
    recordDepositInWorker(env.path, deposit(a, studentA, "a1")),
    recordDepositInWorker(env.path, deposit(b, studentB, "b2")),
  ]) as Array<{ status: string; refundStatus: string; copyId: string | null }>;
  assert.deepEqual(results.map((result) => result.status).sort(), ["PENDING_APPROVAL", "REJECTED_NO_COPY"]);
  assert.equal(results.filter((result) => result.copyId === "copy-001").length, 1);
  assert.equal(results.find((result) => result.status === "REJECTED_NO_COPY")?.refundStatus, "REFUND_DUE");

  const check = new LibraryRepository(env.path);
  t.after(() => { check.close(); env.cleanup(); });
  assert.equal(check.listBooks()[0].copiesAvailable, 0);
  assert.equal([check.getRequest(a)?.copyId, check.getRequest(b)?.copyId].filter(Boolean).length, 1);
});

test("database unique index rejects duplicate active copy allocation outside repository code", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  repository.seedDemo(env.seed);
  const a = `0x${"01".repeat(32)}`;
  const b = `0x${"02".repeat(32)}`;
  repository.createDepositRequest({ requestId: a, wallet: studentA, bookId, idempotencyKey: "req-a", createdAt: 1_799_900_000, chainTime: 1_799_900_000, holdAfterSeconds: 2_592_000 });
  repository.createDepositRequest({ requestId: b, wallet: studentB, bookId, idempotencyKey: "req-b", createdAt: 1_799_900_000, chainTime: 1_799_900_000, holdAfterSeconds: 2_592_000 });
  repository.close();
  t.after(env.cleanup);
  const db = new DatabaseSync(env.path);
  try {
    db.prepare("UPDATE borrow_requests SET copy_id = ?, status = 'PENDING_APPROVAL' WHERE request_id = ?").run("copy-001", a);
    assert.throws(() => db.prepare("UPDATE borrow_requests SET copy_id = ?, status = 'PENDING_APPROVAL' WHERE request_id = ?").run("copy-001", b),
      /uq_library_active_copy_allocation|UNIQUE constraint failed/i);
  } finally { db.close(); }
});

test("loan rows must match their request and an active physical copy cannot back two loans", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  repository.seedDemo(env.seed);
  const a = `0x${"01".repeat(32)}`;
  const b = `0x${"02".repeat(32)}`;
  repository.createDepositRequest({ requestId: a, wallet: studentA, bookId, idempotencyKey: "req-a", createdAt: 1_799_900_000, chainTime: 1_799_900_000, holdAfterSeconds: 2_592_000 });
  repository.createDepositRequest({ requestId: b, wallet: studentB, bookId, idempotencyKey: "req-b", createdAt: 1_799_900_000, chainTime: 1_799_900_000, holdAfterSeconds: 2_592_000 });
  repository.close();
  t.after(env.cleanup);
  const db = new DatabaseSync(env.path);
  db.exec("PRAGMA foreign_keys=ON");
  try {
    const loanInsert = db.prepare(`INSERT INTO loans(loan_id, request_id, book_id, copy_id, account_id, status,
      deposit_wei, replacement_price_wei, policy_json, approved_at, due_at, created_at, updated_at)
      SELECT request_id, request_id, book_id, ?, account_id, 'ACTIVE', ?, ?, '{}', 1, 2, 1, 1
      FROM borrow_requests WHERE request_id = ?`);
    assert.throws(() => loanInsert.run("copy-001", depositWei, priceWei, a), /FOREIGN KEY constraint failed/i);
    db.prepare("UPDATE borrow_requests SET copy_id = 'copy-001', status = 'RETURNED' WHERE request_id = ?").run(a);
    db.prepare("UPDATE borrow_requests SET copy_id = 'copy-001', status = 'RETURNED' WHERE request_id = ?").run(b);
    loanInsert.run("copy-001", depositWei, priceWei, a);
    assert.throws(() => loanInsert.run("copy-001", depositWei, priceWei, b), /uq_library_active_loan_copy|UNIQUE constraint failed/i);
  } finally { db.close(); }
});

test("verified event replay is idempotent and a chain event key cannot confirm another request", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  const a = `0x${"01".repeat(32)}`;
  const b = `0x${"02".repeat(32)}`;
  repository.createDepositRequest({ requestId: a, wallet: studentA, bookId, idempotencyKey: "req-a", createdAt: 1_799_900_000, chainTime: 1_799_900_000, holdAfterSeconds: 2_592_000 });
  repository.createDepositRequest({ requestId: b, wallet: studentB, bookId, idempotencyKey: "req-b", createdAt: 1_799_900_000, chainTime: 1_799_900_000, holdAfterSeconds: 2_592_000 });
  const event = deposit(a, studentA, "a1");
  assert.equal(repository.recordVerifiedDeposit(event).status, "PENDING_APPROVAL");
  assert.equal(repository.recordVerifiedDeposit(event).duplicate, true);
  assert.throws(() => repository.recordVerifiedDeposit({ ...deposit(b, studentB, "a1"), logIndex: event.logIndex }),
    { message: "LIBRARY_EVENT_CONFLICT" });
});

test("a librarian can refund a verified no-copy deposit through the reject event and queue", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  const first = `0x${"61".repeat(32)}`, noCopy = `0x${"62".repeat(32)}`;
  repository.createDepositRequest({ requestId: first, wallet: studentA, bookId, idempotencyKey: "no-copy-first",
    createdAt: 100, chainTime: 100, holdAfterSeconds: 2_592_000 });
  repository.createDepositRequest({ requestId: noCopy, wallet: studentB, bookId, idempotencyKey: "no-copy-second",
    createdAt: 100, chainTime: 100, holdAfterSeconds: 2_592_000 });
  repository.recordVerifiedDeposit(deposit(first, studentA, "a1"));
  assert.equal(repository.recordVerifiedDeposit(deposit(noCopy, studentB, "b2")).status, "REJECTED_NO_COPY");
  assert.deepEqual(repository.listRequests(librarian, true).map((request) => request.requestId).sort(), [first, noCopy]);

  const rejected = { chainId: 20261 as const, contractAddress: "0x4444444444444444444444444444444444444444",
    txHash: `0x${"63".repeat(32)}`, logIndex: 0, blockNumber: 124, blockHash: `0x${"64".repeat(32)}`,
    blockTimestamp: 200, transactionFrom: librarian, observedAt: 200, eventName: "RequestRejected" as const,
    requestId: noCopy, borrower: studentB, refundWei: depositWei };
  repository.recordVerifiedChainEvents([rejected], 124, 200, "{}");

  assert.deepEqual(repository.listRequests(librarian, true).map((request) => request.requestId), [first]);
  assert.deepEqual(repository.getRequest(noCopy), {
    requestId: noCopy, wallet: studentB, bookId, copyId: null, status: "REJECTED", refundStatus: "REFUNDED",
    depositWei, approvalDeadline: 1_800_000_000, createdAt: 100, updatedAt: 200,
  });
  assert.equal(repository.listBooks()[0].copiesAvailable, 0, "no-copy refund must not release another request's copy");
});

test("idempotency keys are limited by the 8 KB request body rather than an undocumented 200-character cap", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  const request = repository.createDepositRequest({ requestId: `0x${"65".repeat(32)}`, wallet: studentA, bookId,
    idempotencyKey: "k".repeat(201), createdAt: 100, chainTime: 100, holdAfterSeconds: 2_592_000 });
  assert.equal(request.status, "AWAITING_DEPOSIT");
});

test("reconcile skips untracked logs, atomically advances after projections, and applies approval before late expiry", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  const requestId = `0x${"31".repeat(32)}`;
  const depositedAt = 1_799_913_600;
  const deadline = 1_800_000_000;
  repository.createDepositRequest({ requestId, wallet: studentA, bookId, idempotencyKey: "reconcile", createdAt: depositedAt - 1,
    chainTime: depositedAt - 1, holdAfterSeconds: 2_592_000 });
  const depositEvent: LibraryVerifiedChainEvent = {
    chainId: 20261, contractAddress: "0x4444444444444444444444444444444444444444",
    txHash: `0x${"41".repeat(32)}`, logIndex: 0, blockNumber: 123, blockHash: `0x${"51".repeat(32)}`,
    blockTimestamp: depositedAt, transactionFrom: studentA, observedAt: deadline + 10,
    eventName: "DepositReceived", requestId, borrower: studentA, bookId, amountWei: depositWei,
    depositedAt, approvalDeadline: deadline,
  };
  const untracked = { ...depositEvent, requestId: `0x${"32".repeat(32)}`, txHash: `0x${"42".repeat(32)}`, blockNumber: 122 };
  assert.deepEqual(repository.recordVerifiedChainEvents([untracked, depositEvent], 123, deadline + 10, "{}"),
    { applied: 1, duplicates: 0, ignored: 1, cursorBlock: 123 });
  assert.equal(repository.getRequest(requestId)?.status, "PENDING_APPROVAL");
  assert.equal(repository.reconcileState().cursorBlock, 123);

  const approvalEvent: LibraryVerifiedChainEvent = {
    chainId: 20261, contractAddress: depositEvent.contractAddress, txHash: `0x${"43".repeat(32)}`,
    logIndex: 0, blockNumber: 124, blockHash: `0x${"52".repeat(32)}`, blockTimestamp: deadline - 1,
    transactionFrom: librarian, observedAt: deadline + 100, eventName: "LoanApproved", requestId,
    borrower: studentA, approvedAt: deadline - 1, dueAt: deadline + 1_209_599, replacementPriceWei: priceWei,
  };
  assert.deepEqual(repository.recordVerifiedChainEvents([approvalEvent], 124, deadline + 100, "{\"loanDurationSeconds\":1209600}"),
    { applied: 1, duplicates: 0, ignored: 0, cursorBlock: 124 });
  assert.equal(repository.getRequest(requestId)?.status, "APPROVED");
  assert.equal(repository.listBooks()[0].copiesAvailable, 0);
  assert.equal(repository.recordVerifiedChainEvents([approvalEvent], 125, deadline + 101, "{}").duplicates, 1);
  assert.equal(repository.reconcileState().cursorBlock, 125);
});

test("settlement retries preserve reverted attempts and link each successful receipt to its exact intent", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo({ ...env.seed, books: [{ ...env.seed.books[0], copies: [
    { copyId: "copy-001", barcode: "LC-001" }, { copyId: "copy-002", barcode: "LC-002" },
    { copyId: "copy-003", barcode: "LC-003" }, { copyId: "copy-004", barcode: "LC-004" },
  ] }] });

  const addIntentPair = (requestId: string, createdAt: number, label = "first") => {
    repository.createSettlementIntent({ intentId: `${requestId}:${label}`, loanId: requestId, librarianWallet: librarian,
      outcome: "LOST", reason: "Reason for submitted settlement", createdAt });
    repository.createSettlementIntent({ intentId: `${requestId}:${label}:later`, loanId: requestId, librarianWallet: librarian,
      outcome: "LOST", reason: "Later unused intent reason", createdAt: createdAt + 1 });
    return `${requestId}:${label}`;
  };
  const lostEvent = (requestId: string, txByte: string, block: number, blockTimestamp: number): LibraryVerifiedChainEvent => ({
    chainId: 20261, contractAddress: "0x4444444444444444444444444444444444444444",
    txHash: `0x${txByte.repeat(32)}`, logIndex: 0, blockNumber: block,
    blockHash: `0x${(block + 80).toString(16).padStart(64, "0")}`,
    blockTimestamp, transactionFrom: librarian, observedAt: blockTimestamp + 10, eventName: "LostSettled", requestId,
    borrower: studentA, replacementPriceWei: priceWei, retainedWei: priceWei, refundWei: "20000000000000000000", shortfallWei: "0",
  });

  const trackedRequest = `0x${"81".repeat(32)}`;
  recordActiveLoan(repository, trackedRequest, 150, 1_700_000_000);
  const trackedIntent = addIntentPair(trackedRequest, 1_702_000_000);
  const trackedHash = `0x${"91".repeat(32)}`;
  repository.recordTransactionSubmission({ requestId: trackedRequest, action: "settle", txHash: trackedHash,
    submittedAt: 1_702_000_010, settlementIntentId: trackedIntent, librarianWallet: librarian });
  repository.recordVerifiedChainEvents([lostEvent(trackedRequest, "91", 152, 1_702_000_020)], 152, 1_702_000_030, "{}");

  const racedRequest = `0x${"82".repeat(32)}`;
  recordActiveLoan(repository, racedRequest, 200, 1_703_000_000);
  const racedIntent = addIntentPair(racedRequest, 1_705_000_000);
  const racedHash = `0x${"92".repeat(32)}`;
  repository.recordVerifiedChainEvents([lostEvent(racedRequest, "92", 202, 1_705_000_020)], 202, 1_705_000_030, "{}");
  repository.recordTransactionSubmission({ requestId: racedRequest, action: "settle", txHash: racedHash,
    submittedAt: 1_705_000_040, settlementIntentId: racedIntent, librarianWallet: librarian });

  const retriedRequest = `0x${"83".repeat(32)}`;
  recordActiveLoan(repository, retriedRequest, 205, 1_706_000_000);
  const revertedIntent = addIntentPair(retriedRequest, 1_708_000_000, "reverted");
  const revertedHash = `0x${"93".repeat(32)}`;
  repository.recordTransactionSubmission({ requestId: retriedRequest, action: "settle", txHash: revertedHash,
    submittedAt: 1_708_000_010, settlementIntentId: revertedIntent, librarianWallet: librarian });
  repository.markTransactionReverted({ requestId: retriedRequest, action: "settle", txHash: revertedHash,
    blockNumber: 206, blockHash: `0x${"a6".repeat(32)}`, checkedAt: 1_708_000_020 });
  const retryIntent = addIntentPair(retriedRequest, 1_709_000_000, "retry");
  const retryHash = `0x${"94".repeat(32)}`;
  repository.recordTransactionSubmission({ requestId: retriedRequest, action: "settle", txHash: retryHash,
    submittedAt: 1_709_000_010, settlementIntentId: retryIntent, librarianWallet: librarian });
  repository.recordVerifiedChainEvents([lostEvent(retriedRequest, "94", 207, 1_709_000_020)], 207, 1_709_000_030, "{}");

  const eventFirstRequest = `0x${"84".repeat(32)}`;
  recordActiveLoan(repository, eventFirstRequest, 208, 1_710_000_000);
  const eventFirstOldIntent = addIntentPair(eventFirstRequest, 1_712_000_000, "reverted");
  const eventFirstOldHash = `0x${"95".repeat(32)}`;
  repository.recordTransactionSubmission({ requestId: eventFirstRequest, action: "settle", txHash: eventFirstOldHash,
    submittedAt: 1_712_000_010, settlementIntentId: eventFirstOldIntent, librarianWallet: librarian });
  repository.markTransactionReverted({ requestId: eventFirstRequest, action: "settle", txHash: eventFirstOldHash,
    blockNumber: 209, blockHash: `0x${"a9".repeat(32)}`, checkedAt: 1_712_000_020 });
  const eventFirstRetryIntent = addIntentPair(eventFirstRequest, 1_713_000_000, "retry");
  const eventFirstRetryHash = `0x${"96".repeat(32)}`;
  repository.recordVerifiedChainEvents([lostEvent(eventFirstRequest, "96", 210, 1_713_000_010)], 210, 1_713_000_020, "{}");
  repository.recordTransactionSubmission({ requestId: eventFirstRequest, action: "settle", txHash: eventFirstRetryHash,
    submittedAt: 1_713_000_030, settlementIntentId: eventFirstRetryIntent, librarianWallet: librarian });

  const db = new DatabaseSync(env.path);
  try {
    const tracked = db.prepare("SELECT reason, settlement_intent_id FROM settlements WHERE loan_id = ?").get(trackedRequest);
    assert.deepEqual(Object.assign({}, tracked), {
      reason: "Reason for submitted settlement", settlement_intent_id: trackedIntent,
    });
    assert.equal(repository.getTransaction(trackedRequest, "settle")?.settlementIntentId, trackedIntent);

    const raced = db.prepare("SELECT reason, settlement_intent_id FROM settlements WHERE loan_id = ?").get(racedRequest);
    assert.deepEqual(Object.assign({}, raced), {
      reason: "Reason for submitted settlement", settlement_intent_id: racedIntent,
    }, "a later POST must attach its exact intent when reconciliation already confirmed the event");
    assert.equal(repository.getTransaction(racedRequest, "settle")?.settlementIntentId, racedIntent);

    const attempts = db.prepare(`SELECT tx_hash, status, settlement_intent_id FROM library_transaction_attempts
      WHERE request_id = ? AND action = 'settle' ORDER BY submitted_at`).all(retriedRequest);
    assert.deepEqual(attempts.map((row) => ({ tx_hash: row.tx_hash, status: row.status, settlement_intent_id: row.settlement_intent_id })), [
      { tx_hash: revertedHash, status: "REVERTED", settlement_intent_id: revertedIntent },
      { tx_hash: retryHash, status: "CONFIRMED", settlement_intent_id: retryIntent },
    ], "a retry keeps the reverted tx and binds its successful attempt to the new intent");
    const eventFirst = db.prepare("SELECT reason, settlement_intent_id FROM settlements WHERE loan_id = ?").get(eventFirstRequest);
    assert.deepEqual(Object.assign({}, eventFirst), {
      reason: "Reason for submitted settlement", settlement_intent_id: eventFirstRetryIntent,
    }, "a successful event arriving before its POST must not inherit the reverted attempt's intent");
  } finally { db.close(); }
});

test("a canonicality mismatch persists reorg health and blocks later projections", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  const requestId = `0x${"33".repeat(32)}`;
  const depositedAt = 1_799_913_600;
  repository.createDepositRequest({ requestId, wallet: studentA, bookId, idempotencyKey: "reorg", createdAt: depositedAt - 1,
    chainTime: depositedAt - 1, holdAfterSeconds: 2_592_000 });
  repository.recordVerifiedChainEvents([{
    chainId: 20261, contractAddress: "0x4444444444444444444444444444444444444444", txHash: `0x${"44".repeat(32)}`,
    logIndex: 0, blockNumber: 123, blockHash: `0x${"53".repeat(32)}`, blockTimestamp: depositedAt,
    transactionFrom: studentA, observedAt: depositedAt + 1, eventName: "DepositReceived", requestId,
    borrower: studentA, bookId, amountWei: depositWei, depositedAt, approvalDeadline: 1_800_000_000,
  }], 123, depositedAt + 1, "{}");
  const db = new DatabaseSync(env.path);
  const eventId = Number(db.prepare("SELECT event_id FROM chain_events WHERE request_id = ?").get(requestId)?.event_id);
  db.close();
  repository.markEventOrphaned({ eventId, observedBlockHash: `0x${"54".repeat(32)}`, checkedAt: depositedAt + 2 });
  assert.equal(repository.reconcileState().health, "REORG_DETECTED");
  assert.throws(() => repository.recordVerifiedChainEvents([], 124, depositedAt + 3, "{}"), { message: "LIBRARY_REORG_DETECTED" });
});

test("a disabled librarian session does not invalidate an already authorized on-chain approval", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  const requestId = `0x${"35".repeat(32)}`;
  const depositedAt = 1_700_000_000;
  const approvedAt = depositedAt + 1;
  repository.createDepositRequest({ requestId, wallet: studentA, bookId, idempotencyKey: "disabled-librarian",
    createdAt: depositedAt - 1, chainTime: depositedAt - 1, holdAfterSeconds: 2_592_000 });
  const common = { chainId: 20261 as const, contractAddress: "0x4444444444444444444444444444444444444444",
    logIndex: 0, observedAt: 1_800_000_000 };
  repository.recordVerifiedChainEvents([{
    ...common, txHash: `0x${"45".repeat(32)}`, blockNumber: 123, blockHash: `0x${"55".repeat(32)}`,
    blockTimestamp: depositedAt, transactionFrom: studentA, eventName: "DepositReceived", requestId,
    borrower: studentA, bookId, amountWei: depositWei, depositedAt, approvalDeadline: depositedAt + 86_400,
  }], 123, 1_800_000_000, "{}");
  repository.setAccountEnabled(librarian, false, depositedAt);
  repository.recordVerifiedChainEvents([{
    ...common, txHash: `0x${"46".repeat(32)}`, blockNumber: 124, blockHash: `0x${"56".repeat(32)}`,
    blockTimestamp: approvedAt, transactionFrom: librarian, eventName: "LoanApproved", requestId,
    borrower: studentA, approvedAt, dueAt: approvedAt + 1_209_600, replacementPriceWei: priceWei,
  }], 124, 1_800_000_000, "{}");

  assert.equal(repository.getRequest(requestId)?.status, "APPROVED");
  assert.equal(repository.listLoans(studentA)[0]?.status, "ACTIVE");
});

test("a busy write-lock acquisition stays a retryable database error", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  repository.seedDemo(env.seed);
  const database = new DatabaseSync(env.path);
  const internal = (repository as unknown as { db: DatabaseSync }).db;
  internal.exec("PRAGMA busy_timeout = 0");
  database.exec("BEGIN IMMEDIATE");
  t.after(() => {
    try { database.exec("ROLLBACK"); } catch { /* the test may already have released it */ }
    database.close();
    repository.close();
    env.cleanup();
  });

  assert.throws(() => repository.accountStatus(studentA, 1_800_000_000, 2_592_000), { message: "LIBRARY_DATABASE_BUSY" });
});

test("disabling an account revokes its stored sessions in the same transaction", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  repository.createChallenge({ challengeId: "challenge-1", wallet: studentA, nonce: "unique-nonce-1",
    message: "login challenge for test", createdAt: 100, expiresAt: 200 });
  repository.consumeChallengeAndCreateSession({ challengeId: "challenge-1", tokenHash: "a".repeat(64), now: 110, expiresAt: 210 });
  repository.setAccountEnabled(studentA, false, 150);
  assert.equal(repository.getSession("a".repeat(64), 151), undefined);
  assert.equal(repository.accountForWallet(studentA)?.enabled, false);
});

test("challenge expiry is exclusive and successful consumption is one-use", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  repository.createChallenge({ challengeId: "challenge-expired", wallet: studentA, nonce: "nonce-expired",
    message: "expired login challenge", createdAt: 100, expiresAt: 200 });
  assert.throws(() => repository.consumeChallengeAndCreateSession({ challengeId: "challenge-expired",
    tokenHash: "b".repeat(64), now: 200, expiresAt: 300 }), { message: "LIBRARY_CHALLENGE_INVALID" });
  assert.equal(repository.getChallenge("challenge-expired")?.consumedAt, null);

  repository.createChallenge({ challengeId: "challenge-valid", wallet: studentA, nonce: "nonce-valid",
    message: "valid login challenge", createdAt: 100, expiresAt: 200 });
  repository.consumeChallengeAndCreateSession({ challengeId: "challenge-valid", tokenHash: "c".repeat(64), now: 199, expiresAt: 300 });
  assert.equal(repository.getChallenge("challenge-valid")?.consumedAt, 199);
  assert.throws(() => repository.consumeChallengeAndCreateSession({ challengeId: "challenge-valid",
    tokenHash: "d".repeat(64), now: 199, expiresAt: 300 }), { message: "LIBRARY_CHALLENGE_INVALID" });
  assert.equal(repository.getSession("d".repeat(64), 199), undefined);
});

test("auth rate limits persist atomically per scope and reset on the exact window boundary", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  const subjectHash = "d".repeat(64);
  assert.deepEqual(repository.consumeAuthRateLimit({ scope: "challenge", subjectHash, now: 119, maxRequests: 1, windowSeconds: 60 }),
    { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(repository.consumeAuthRateLimit({ scope: "challenge", subjectHash, now: 119, maxRequests: 1, windowSeconds: 60 }),
    { allowed: false, retryAfterSeconds: 1 });
  assert.deepEqual(repository.consumeAuthRateLimit({ scope: "verify", subjectHash, now: 119, maxRequests: 1, windowSeconds: 60 }),
    { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(repository.consumeAuthRateLimit({ scope: "challenge", subjectHash, now: 120, maxRequests: 1, windowSeconds: 60 }),
    { allowed: true, retryAfterSeconds: 0 });
});

test("auth activity reclaims expired challenges and sessions in bounded batches while preserving live rows", (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  t.after(() => { repository.close(); env.cleanup(); });
  repository.seedDemo(env.seed);
  const batchSize = 256;
  for (let index = 0; index < batchSize + 1; index += 1) {
    const id = `challenge-expired-${index}`;
    repository.createChallenge({ challengeId: id, wallet: studentA, nonce: `expired-nonce-${index}`,
      message: "expired challenge", createdAt: 100, expiresAt: 200 });
    repository.consumeChallengeAndCreateSession({ challengeId: id, tokenHash: index.toString(16).padStart(64, "0"),
      now: 199, expiresAt: 300 });
  }
  repository.createChallenge({ challengeId: "challenge-revoked", wallet: studentA, nonce: "revoked-nonce",
    message: "revoked challenge", createdAt: 100, expiresAt: 200 });
  repository.consumeChallengeAndCreateSession({ challengeId: "challenge-revoked", tokenHash: "f".repeat(64), now: 199, expiresAt: 1000 });
  repository.revokeSession("f".repeat(64), 250);
  repository.createChallenge({ challengeId: "challenge-live", wallet: studentA, nonce: "live-nonce",
    message: "live challenge", createdAt: 250, expiresAt: 500 });
  repository.consumeChallengeAndCreateSession({ challengeId: "challenge-live", tokenHash: "e".repeat(64), now: 250, expiresAt: 1000 });

  repository.consumeAuthRateLimit({ scope: "challenge", subjectHash: "d".repeat(64), now: 300, maxRequests: 10, windowSeconds: 60 });

  const db = new DatabaseSync(env.path);
  try {
    const challengeCount = Number(db.prepare("SELECT count(*) AS count FROM auth_challenges").get()?.count);
    const sessionCount = Number(db.prepare("SELECT count(*) AS count FROM auth_sessions").get()?.count);
    assert.equal(challengeCount, 3, "one bounded batch is removed and the live challenge remains");
    assert.equal(sessionCount, 2, "one expired session remains after the bounded batch; live session remains");
    assert.equal(repository.getChallenge("challenge-live")?.expiresAt, 500);
    assert.equal(repository.getSession("e".repeat(64), 300)?.expiresAt, 1000);
    assert.equal(repository.getSession("f".repeat(64), 300), undefined);
  } finally { db.close(); }
});

test("concurrent verification consumes a challenge once and creates one session", async (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  repository.seedDemo(env.seed);
  repository.createChallenge({ challengeId: "race-challenge", wallet: studentA, nonce: "race-nonce",
    message: "challenge to race", createdAt: 100, expiresAt: 200 });
  repository.close();
  const outcomes = await Promise.allSettled([
    consumeChallengeInWorker(env.path, "a"),
    consumeChallengeInWorker(env.path, "b"),
  ]);
  const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const failures = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal((failures[0] as PromiseRejectedResult).reason.message, "LIBRARY_CHALLENGE_INVALID");
  const restored = new LibraryRepository(env.path);
  t.after(() => { restored.close(); env.cleanup(); });
  assert.equal(restored.getChallenge("race-challenge")?.consumedAt, 199);
  assert.equal(["a", "b"].filter((byte) => restored.getSession(byte.repeat(64), 199)).length, 1);
});

test("online SQLite backup reopens with catalog, account, and request history", async (t) => {
  const env = setup();
  const repository = new LibraryRepository(env.path);
  repository.seedDemo(env.seed);
  const requestId = `0x${"01".repeat(32)}`;
  repository.createDepositRequest({ requestId, wallet: studentA, bookId, idempotencyKey: "backup-request", createdAt: 1_799_900_000,
    chainTime: 1_799_900_000, holdAfterSeconds: 2_592_000 });
  const backupPath = join(env.directory, "backup", "library-copy.sqlite");
  assert.ok(await repository.backupTo(backupPath) > 0);
  repository.close();
  const restored = new LibraryRepository(backupPath);
  t.after(() => { restored.close(); env.cleanup(); });
  assert.equal(restored.getRequest(requestId)?.status, "AWAITING_DEPOSIT");
  assert.equal(restored.accountForWallet(studentA)?.enabled, true);
  assert.equal(restored.listBooks()[0].copiesAvailable, 1);
});
