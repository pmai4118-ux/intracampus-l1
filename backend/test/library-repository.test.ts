import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { LibraryRepository, applyLibraryMigrations } from "../src/modules/library/library.repository.ts";
import type { LibraryBookSeed } from "../src/modules/library/library.types.ts";

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
  assert.equal(repository.schemaVersion(), 1);
  assert.deepEqual(repository.sqliteSettings(), { foreignKeys: 1, journalMode: "wal", synchronous: 2, busyTimeoutMs: 5000 });
  assert.equal(repository.seedDemo(env.seed), "inserted");
  repository.close();

  repository = new LibraryRepository(env.path);
  assert.equal(repository.schemaVersion(), 1);
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

test("migration failure rolls back its schema and version", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(() => applyLibraryMigrations(db, [{ version: 1,
      sql: "CREATE TABLE partial_migration(id INTEGER PRIMARY KEY); THIS IS INVALID SQL;" }]), /syntax|error/i);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial_migration'").get(), undefined);
  } finally { db.close(); }
});

test("two independent startup processes migrate a new file database once", async (t) => {
  const env = setup();
  t.after(env.cleanup);
  const versions = await Promise.all([
    initializeDatabaseInWorker(env.path),
    initializeDatabaseInWorker(env.path),
  ]);
  assert.deepEqual(versions, [1, 1]);
  const repository = new LibraryRepository(env.path);
  assert.equal(repository.schemaVersion(), 1);
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
  repository.createDepositRequest({ requestId: a, wallet: studentA, bookId, idempotencyKey: "req-a", createdAt: 1_799_900_000 });
  repository.createDepositRequest({ requestId: b, wallet: studentB, bookId, idempotencyKey: "req-b", createdAt: 1_799_900_000 });
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
  repository.createDepositRequest({ requestId: a, wallet: studentA, bookId, idempotencyKey: "req-a", createdAt: 1_799_900_000 });
  repository.createDepositRequest({ requestId: b, wallet: studentB, bookId, idempotencyKey: "req-b", createdAt: 1_799_900_000 });
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
  repository.createDepositRequest({ requestId: a, wallet: studentA, bookId, idempotencyKey: "req-a", createdAt: 1_799_900_000 });
  repository.createDepositRequest({ requestId: b, wallet: studentB, bookId, idempotencyKey: "req-b", createdAt: 1_799_900_000 });
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
  repository.createDepositRequest({ requestId: a, wallet: studentA, bookId, idempotencyKey: "req-a", createdAt: 1_799_900_000 });
  repository.createDepositRequest({ requestId: b, wallet: studentB, bookId, idempotencyKey: "req-b", createdAt: 1_799_900_000 });
  const event = deposit(a, studentA, "a1");
  assert.equal(repository.recordVerifiedDeposit(event).status, "PENDING_APPROVAL");
  assert.equal(repository.recordVerifiedDeposit(event).duplicate, true);
  assert.throws(() => repository.recordVerifiedDeposit({ ...deposit(b, studentB, "a1"), logIndex: event.logIndex }),
    { message: "LIBRARY_EVENT_CONFLICT" });
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
  repository.createDepositRequest({ requestId, wallet: studentA, bookId, idempotencyKey: "backup-request", createdAt: 1_799_900_000 });
  const backupPath = join(env.directory, "backup", "library-copy.sqlite");
  assert.ok(await repository.backupTo(backupPath) > 0);
  repository.close();
  const restored = new LibraryRepository(backupPath);
  t.after(() => { restored.close(); env.cleanup(); });
  assert.equal(restored.getRequest(requestId)?.status, "AWAITING_DEPOSIT");
  assert.equal(restored.accountForWallet(studentA)?.enabled, true);
  assert.equal(restored.listBooks()[0].copiesAvailable, 1);
});
