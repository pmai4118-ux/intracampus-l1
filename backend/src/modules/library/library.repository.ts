import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { libraryMigrations, type LibraryMigration } from "./library.migrations.ts";
import type {
  LibraryAccountSeed,
  LibraryBookRecord,
  LibraryChallengeRecord,
  LibraryDbRefundStatus,
  LibraryDbRequestStatus,
  LibraryDemoSeed,
  LibraryDepositProjection,
  LibraryRequestRecord,
  LibrarySessionRecord,
  LibraryVerifiedDeposit,
} from "./library.types.ts";

const addressPattern = /^0x[0-9a-f]{40}$/i;
const bytes32Pattern = /^0x[0-9a-f]{64}$/i;
const integerStringPattern = /^(0|[1-9][0-9]*)$/;
const fixedDepositWei = "50000000000000000000";
const authCleanupBatchSize = 256;

function canonicalWallet(value: string): string {
  if (!addressPattern.test(value) || /^0x0{40}$/i.test(value)) throw new Error("INVALID_LIBRARY_WALLET");
  return value.toLowerCase();
}

function canonicalBytes32(value: string, code: string): string {
  if (!bytes32Pattern.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function canonicalWei(value: string, positive = false): string {
  if (typeof value !== "string" || !integerStringPattern.test(value)) throw new Error("INVALID_LIBRARY_WEI");
  const amount = BigInt(value);
  if (amount >= 2n ** 256n || (positive && amount === 0n)) throw new Error("INVALID_LIBRARY_WEI");
  return value;
}

function safeInteger(value: number, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(code);
  return value;
}

function setWalWithBusyRetry(db: DatabaseSync): void {
  const deadline = Date.now() + 10_000;
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (true) {
    try {
      const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
      if (mode !== "wal") throw new Error("LIBRARY_WAL_UNAVAILABLE");
      return;
    } catch (error) {
      const busy = error instanceof Error && (error.message.toLowerCase().includes("database is locked")
        || ("code" in error && typeof error.code === "string" && /SQLITE_(BUSY|LOCKED)/.test(error.code)));
      if (!busy || Date.now() >= deadline) throw error;
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
}

function stableSeed(seed: LibraryDemoSeed): LibraryDemoSeed {
  safeInteger(seed.version, "INVALID_LIBRARY_SEED", 1);
  if (!Array.isArray(seed.books) || !Array.isArray(seed.accounts) || seed.books.length === 0 || seed.accounts.length === 0) {
    throw new Error("INVALID_LIBRARY_SEED");
  }
  const books = seed.books.map((book) => {
    const bookId = canonicalBytes32(book.bookId, "INVALID_LIBRARY_BOOK_ID");
    if (!book.title?.trim() || !book.author?.trim()) throw new Error("INVALID_LIBRARY_SEED");
    if (book.isbn !== null && typeof book.isbn !== "string") throw new Error("INVALID_LIBRARY_SEED");
    const depositWei = canonicalWei(book.depositWei, true);
    if (depositWei !== fixedDepositWei) throw new Error("INVALID_LIBRARY_DEPOSIT");
    const replacementPriceWei = canonicalWei(book.replacementPriceWei, true);
    if (!Array.isArray(book.copies) || book.copies.length === 0) throw new Error("INVALID_LIBRARY_SEED");
    const copies = book.copies.map((copy) => {
      if (!copy.copyId?.trim() || !copy.barcode?.trim()) throw new Error("INVALID_LIBRARY_SEED");
      return { copyId: copy.copyId.trim(), barcode: copy.barcode.trim() };
    }).sort((a, b) => a.copyId.localeCompare(b.copyId));
    if (new Set(copies.map((copy) => copy.copyId)).size !== copies.length
      || new Set(copies.map((copy) => copy.barcode)).size !== copies.length) throw new Error("INVALID_LIBRARY_SEED");
    return { bookId, title: book.title.trim(), author: book.author.trim(), isbn: book.isbn?.trim() || null,
      depositWei, replacementPriceWei, copies };
  }).sort((a, b) => a.bookId.localeCompare(b.bookId));
  const accounts: LibraryAccountSeed[] = seed.accounts.map((account) => {
    if (account.role !== "STUDENT" && account.role !== "LIBRARIAN") throw new Error("INVALID_LIBRARY_SEED");
    return { wallet: canonicalWallet(account.wallet), role: account.role };
  }).sort((a, b) => a.wallet.localeCompare(b.wallet));
  if (new Set(books.map((book) => book.bookId)).size !== books.length
    || new Set(accounts.map((account) => account.wallet)).size !== accounts.length
    || !accounts.some((account) => account.role === "STUDENT")
    || accounts.filter((account) => account.role === "LIBRARIAN").length !== 1) throw new Error("INVALID_LIBRARY_SEED");
  return { version: seed.version, books, accounts };
}

export function applyLibraryMigrations(db: DatabaseSync, migrations: readonly LibraryMigration[] = libraryMigrations): void {
  const versions = migrations.map((migration) => migration.version);
  if (versions.some((version, index) => !Number.isSafeInteger(version) || version < 1 || (index > 0 && version <= versions[index - 1]))) {
    throw new Error("INVALID_LIBRARY_MIGRATION_SEQUENCE");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const appliedVersion = db.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof appliedVersion !== "number" || !Number.isSafeInteger(appliedVersion) || appliedVersion < 0) throw new Error("INVALID_LIBRARY_SCHEMA_VERSION");
    if (appliedVersion > (migrations.at(-1)?.version ?? 0)) throw new Error("LIBRARY_SCHEMA_NEWER_THAN_CODE");
    let currentVersion = appliedVersion;
    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;
      if (migration.version !== currentVersion + 1) throw new Error("LIBRARY_SCHEMA_VERSION_GAP");
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      currentVersion = migration.version;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rowToRequest(row: Record<string, unknown> | undefined): LibraryRequestRecord | undefined {
  if (!row) return undefined;
  return {
    requestId: String(row.request_id), wallet: String(row.wallet), bookId: String(row.book_id),
    copyId: row.copy_id === null ? null : String(row.copy_id), status: String(row.status) as LibraryDbRequestStatus,
    refundStatus: String(row.refund_status) as LibraryDbRefundStatus,
    depositWei: row.deposit_wei === null ? null : String(row.deposit_wei),
    approvalDeadline: row.approval_deadline === null ? null : Number(row.approval_deadline),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export class LibraryRepository {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;
  private closed = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.databasePath = path;
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      if (path !== ":memory:") setWalWithBusyRetry(this.db);
      this.db.exec("PRAGMA synchronous = FULL;");
      applyLibraryMigrations(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  async backupTo(path: string): Promise<number> {
    if (!path.trim() || path === ":memory:" || (this.databasePath !== ":memory:" && resolve(path) === resolve(this.databasePath))) {
      throw new Error("INVALID_LIBRARY_BACKUP_PATH");
    }
    mkdirSync(dirname(path), { recursive: true });
    return backup(this.db, path);
  }

  schemaVersion(): number {
    const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
    if (typeof version !== "number" || !Number.isSafeInteger(version)) throw new Error("INVALID_LIBRARY_SCHEMA_VERSION");
    return version;
  }

  sqliteSettings(): { foreignKeys: number; journalMode: string; synchronous: number; busyTimeoutMs: number } {
    return {
      foreignKeys: Number(this.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys),
      journalMode: String(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode),
      synchronous: Number(this.db.prepare("PRAGMA synchronous").get()?.synchronous),
      busyTimeoutMs: Number(this.db.prepare("PRAGMA busy_timeout").get()?.timeout),
    };
  }

  seedDemo(input: LibraryDemoSeed): "inserted" | "unchanged" {
    const seed = stableSeed(input);
    const serialized = JSON.stringify(seed);
    const hash = createHash("sha256").update(serialized, "utf8").digest("hex");
    const now = Math.floor(Date.now() / 1000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT seed_version, seed_hash FROM library_seed_state WHERE singleton = 1").get();
      if (previous) {
        if (previous.seed_version === seed.version && previous.seed_hash === hash) {
          this.db.exec("COMMIT");
          return "unchanged";
        }
        throw new Error("LIBRARY_SEED_CONFLICT");
      }
      for (const account of seed.accounts) {
        this.db.prepare("INSERT INTO accounts(wallet, role, enabled, created_at) VALUES (?, ?, 1, ?)")
          .run(account.wallet, account.role, now);
      }
      for (const book of seed.books) {
        this.db.prepare(`INSERT INTO books(book_id, isbn, title, author, replacement_price_wei, deposit_wei, seed_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(book.bookId, book.isbn, book.title, book.author, book.replacementPriceWei, book.depositWei, seed.version, now);
        for (const copy of book.copies) {
          this.db.prepare("INSERT INTO book_copies(copy_id, book_id, barcode, status, created_at) VALUES (?, ?, ?, 'AVAILABLE', ?)")
            .run(copy.copyId, book.bookId, copy.barcode, now);
        }
      }
      this.db.prepare("INSERT INTO library_seed_state(singleton, seed_version, seed_hash, applied_at) VALUES (1, ?, ?, ?)")
        .run(seed.version, hash, now);
      this.db.exec("COMMIT");
      return "inserted";
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof Error && error.message === "LIBRARY_SEED_CONFLICT") throw error;
      if (error instanceof Error && (error.message.includes("UNIQUE constraint failed") || error.message.includes("FOREIGN KEY constraint failed"))) {
        throw new Error("LIBRARY_SEED_CONFLICT");
      }
      throw error;
    }
  }

  listBooks(query = ""): LibraryBookRecord[] {
    const normalizedQuery = query.trim().replace(/[\\%_]/g, "\\$&");
    const rows = this.db.prepare(`SELECT b.book_id, b.title, b.author, b.isbn, b.deposit_wei, b.replacement_price_wei,
      count(c.copy_id) AS copies_total,
      sum(CASE WHEN c.status = 'AVAILABLE' THEN 1 ELSE 0 END) AS copies_available
      FROM books b LEFT JOIN book_copies c ON c.book_id = b.book_id
      WHERE ? = '' OR b.title LIKE '%' || ? || '%' ESCAPE '\\' OR b.author LIKE '%' || ? || '%' ESCAPE '\\' OR coalesce(b.isbn, '') LIKE '%' || ? || '%' ESCAPE '\\'
      GROUP BY b.book_id ORDER BY b.title COLLATE NOCASE, b.book_id`).all(normalizedQuery, normalizedQuery, normalizedQuery, normalizedQuery);
    return rows.map((row) => ({
      bookId: String(row.book_id), title: String(row.title), author: String(row.author), isbn: row.isbn === null ? null : String(row.isbn),
      depositWei: String(row.deposit_wei), replacementPriceWei: String(row.replacement_price_wei),
      copiesTotal: Number(row.copies_total), copiesAvailable: Number(row.copies_available),
    }));
  }

  accountForWallet(wallet: string): { wallet: string; role: "STUDENT" | "LIBRARIAN"; enabled: boolean } | undefined {
    const normalized = canonicalWallet(wallet);
    const row = this.db.prepare("SELECT wallet, role, enabled FROM accounts WHERE wallet = ? COLLATE NOCASE").get(normalized);
    if (!row) return undefined;
    return { wallet: String(row.wallet), role: String(row.role) as "STUDENT" | "LIBRARIAN", enabled: Number(row.enabled) === 1 };
  }

  createDepositRequest(input: { requestId: string; wallet: string; bookId: string; idempotencyKey: string; createdAt: number }): LibraryRequestRecord {
    const requestId = canonicalBytes32(input.requestId, "INVALID_LIBRARY_REQUEST_ID");
    const wallet = canonicalWallet(input.wallet);
    const bookId = canonicalBytes32(input.bookId, "INVALID_LIBRARY_BOOK_ID");
    safeInteger(input.createdAt, "INVALID_LIBRARY_TIMESTAMP");
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new Error("INVALID_LIBRARY_IDEMPOTENCY_KEY");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = rowToRequest(this.db.prepare(`SELECT r.*, a.wallet FROM borrow_requests r JOIN accounts a USING(account_id)
        WHERE r.account_id = (SELECT account_id FROM accounts WHERE wallet = ? COLLATE NOCASE) AND r.idempotency_key = ?`)
        .get(wallet, input.idempotencyKey));
      if (existing) {
        if (existing.bookId !== bookId) throw new Error("LIBRARY_IDEMPOTENCY_CONFLICT");
        this.db.exec("COMMIT");
        return existing;
      }
      const account = this.db.prepare("SELECT account_id, role, enabled FROM accounts WHERE wallet = ? COLLATE NOCASE").get(wallet);
      if (!account || Number(account.enabled) !== 1 || account.role !== "STUDENT") throw new Error("LIBRARY_ACCOUNT_NOT_ALLOWED");
      const hasBook = this.db.prepare("SELECT 1 AS found FROM books WHERE book_id = ?").get(bookId);
      if (!hasBook) throw new Error("LIBRARY_BOOK_NOT_FOUND");
      const available = this.db.prepare("SELECT 1 AS found FROM book_copies WHERE book_id = ? AND status = 'AVAILABLE' LIMIT 1").get(bookId);
      if (!available) throw new Error("LIBRARY_NO_AVAILABLE_COPY");
      this.db.prepare(`INSERT INTO borrow_requests(request_id, account_id, book_id, idempotency_key, status, refund_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'AWAITING_DEPOSIT', 'NONE', ?, ?)`)
        .run(requestId, Number(account.account_id), bookId, input.idempotencyKey, input.createdAt, input.createdAt);
      const request = this.getRequest(requestId);
      if (!request) throw new Error("LIBRARY_REQUEST_WRITE_FAILED");
      this.db.exec("COMMIT");
      return request;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordVerifiedDeposit(input: LibraryVerifiedDeposit): LibraryDepositProjection {
    const event = {
      requestId: canonicalBytes32(input.requestId, "INVALID_LIBRARY_REQUEST_ID"),
      borrower: canonicalWallet(input.borrower),
      bookId: canonicalBytes32(input.bookId, "INVALID_LIBRARY_BOOK_ID"),
      depositWei: canonicalWei(input.depositWei, true),
      approvalDeadline: safeInteger(input.approvalDeadline, "INVALID_LIBRARY_TIMESTAMP", 1),
      chainId: input.chainId,
      contractAddress: canonicalWallet(input.contractAddress),
      txHash: canonicalBytes32(input.txHash, "INVALID_LIBRARY_TX_HASH"),
      logIndex: safeInteger(input.logIndex, "INVALID_LIBRARY_LOG_INDEX"),
      blockNumber: safeInteger(input.blockNumber, "INVALID_LIBRARY_BLOCK_NUMBER", 1),
      blockHash: canonicalBytes32(input.blockHash, "INVALID_LIBRARY_BLOCK_HASH"),
      eventName: input.eventName,
      occurredAt: safeInteger(input.occurredAt, "INVALID_LIBRARY_TIMESTAMP", 1),
    };
    if (event.chainId !== 20261 || event.eventName !== "DepositReceived" || event.approvalDeadline <= event.occurredAt) {
      throw new Error("INVALID_LIBRARY_VERIFIED_DEPOSIT");
    }
    const payload = JSON.stringify(event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare(`SELECT request_id, payload_json FROM chain_events
        WHERE chain_id = ? AND contract_address = ? COLLATE NOCASE AND tx_hash = ? AND log_index = ?`)
        .get(event.chainId, event.contractAddress, event.txHash, event.logIndex);
      if (previous) {
        if (previous.request_id !== event.requestId || previous.payload_json !== payload) throw new Error("LIBRARY_EVENT_CONFLICT");
        const duplicate = this.getDepositProjection(event.requestId, true);
        if (!duplicate) throw new Error("LIBRARY_REQUEST_NOT_FOUND");
        this.db.exec("COMMIT");
        return duplicate;
      }
      const request = this.db.prepare(`SELECT r.request_id, r.account_id, r.book_id, r.status, r.refund_status,
        a.wallet, b.deposit_wei FROM borrow_requests r JOIN accounts a USING(account_id) JOIN books b USING(book_id)
        WHERE r.request_id = ?`).get(event.requestId);
      if (!request) throw new Error("LIBRARY_REQUEST_NOT_FOUND");
      if (request.status !== "AWAITING_DEPOSIT" || String(request.wallet).toLowerCase() !== event.borrower
        || String(request.book_id) !== event.bookId || String(request.deposit_wei) !== event.depositWei) {
        throw new Error("LIBRARY_DEPOSIT_REQUEST_MISMATCH");
      }
      this.db.prepare(`INSERT INTO chain_events(chain_id, contract_address, tx_hash, log_index, block_number, block_hash,
        event_name, request_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.chainId, event.contractAddress, event.txHash, event.logIndex, event.blockNumber, event.blockHash,
          event.eventName, event.requestId, payload, event.occurredAt);

      const copy = this.db.prepare(`SELECT copy_id FROM book_copies WHERE book_id = ? AND status = 'AVAILABLE'
        ORDER BY barcode, copy_id LIMIT 1`).get(event.bookId);
      if (copy) {
        const copyId = String(copy.copy_id);
        const claimed = this.db.prepare("UPDATE book_copies SET status = 'PENDING_APPROVAL' WHERE copy_id = ? AND status = 'AVAILABLE'").run(copyId);
        if (claimed.changes !== 1) throw new Error("LIBRARY_COPY_ALLOCATION_CONFLICT");
        this.db.prepare(`UPDATE borrow_requests SET copy_id = ?, status = 'PENDING_APPROVAL', refund_status = 'NONE',
          deposit_wei = ?, approval_deadline = ?, chain_id = ?, contract_address = ?, deposit_tx_hash = ?, updated_at = ?
          WHERE request_id = ? AND status = 'AWAITING_DEPOSIT'`)
          .run(copyId, event.depositWei, event.approvalDeadline, event.chainId, event.contractAddress, event.txHash, event.occurredAt, event.requestId);
      } else {
        this.db.prepare(`UPDATE borrow_requests SET status = 'REJECTED_NO_COPY', refund_status = 'REFUND_DUE',
          deposit_wei = ?, approval_deadline = ?, chain_id = ?, contract_address = ?, deposit_tx_hash = ?, updated_at = ?
          WHERE request_id = ? AND status = 'AWAITING_DEPOSIT'`)
          .run(event.depositWei, event.approvalDeadline, event.chainId, event.contractAddress, event.txHash, event.occurredAt, event.requestId);
      }
      const projection = this.getDepositProjection(event.requestId, false);
      if (!projection) throw new Error("LIBRARY_REQUEST_NOT_FOUND");
      this.db.exec("COMMIT");
      return projection;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: chain_events")) throw new Error("LIBRARY_EVENT_CONFLICT");
      throw error;
    }
  }

  getRequest(requestId: string): LibraryRequestRecord | undefined {
    const normalized = canonicalBytes32(requestId, "INVALID_LIBRARY_REQUEST_ID");
    return rowToRequest(this.db.prepare(`SELECT r.*, a.wallet FROM borrow_requests r JOIN accounts a USING(account_id)
      WHERE r.request_id = ?`).get(normalized));
  }

  private getDepositProjection(requestId: string, duplicate: boolean): LibraryDepositProjection | undefined {
    const request = this.getRequest(requestId);
    if (!request || !request.approvalDeadline) return undefined;
    return {
      requestId: request.requestId,
      status: request.status,
      refundStatus: request.refundStatus,
      copyId: request.copyId,
      approvalDeadline: request.approvalDeadline,
      duplicate,
    };
  }

  createChallenge(input: { challengeId: string; wallet: string; nonce: string; message: string; createdAt: number; expiresAt: number }): LibraryChallengeRecord {
    if (!input.challengeId.trim() || input.challengeId.length > 200 || !input.nonce.trim() || input.nonce.length > 200
      || !input.message.trim() || input.message.length > 2000) throw new Error("INVALID_LIBRARY_CHALLENGE");
    const wallet = canonicalWallet(input.wallet);
    safeInteger(input.createdAt, "INVALID_LIBRARY_TIMESTAMP");
    safeInteger(input.expiresAt, "INVALID_LIBRARY_TIMESTAMP", 1);
    if (input.expiresAt <= input.createdAt) throw new Error("INVALID_LIBRARY_CHALLENGE_EXPIRY");
    const account = this.db.prepare("SELECT account_id, enabled FROM accounts WHERE wallet = ? COLLATE NOCASE").get(wallet);
    if (!account || Number(account.enabled) !== 1) throw new Error("LIBRARY_ACCOUNT_NOT_ALLOWED");
    this.db.prepare(`INSERT INTO auth_challenges(challenge_id, account_id, nonce, message, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.challengeId, Number(account.account_id), input.nonce, input.message, input.createdAt, input.expiresAt);
    return { challengeId: input.challengeId, wallet, nonce: input.nonce, message: input.message, createdAt: input.createdAt,
      expiresAt: input.expiresAt, consumedAt: null };
  }

  getChallenge(challengeId: string): LibraryChallengeRecord | undefined {
    const row = this.db.prepare(`SELECT c.challenge_id, a.wallet, c.nonce, c.message, c.created_at, c.expires_at, c.consumed_at
      FROM auth_challenges c JOIN accounts a USING(account_id) WHERE c.challenge_id = ?`).get(challengeId);
    if (!row) return undefined;
    return { challengeId: String(row.challenge_id), wallet: String(row.wallet), nonce: String(row.nonce), message: String(row.message),
      createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at) };
  }

  consumeChallengeAndCreateSession(input: { challengeId: string; tokenHash: string; now: number; expiresAt: number }): LibrarySessionRecord {
    const tokenHash = input.tokenHash.toLowerCase();
    safeInteger(input.now, "INVALID_LIBRARY_TIMESTAMP");
    safeInteger(input.expiresAt, "INVALID_LIBRARY_TIMESTAMP", 1);
    if (!/^[0-9a-f]{64}$/.test(tokenHash) || input.expiresAt <= input.now) throw new Error("INVALID_LIBRARY_SESSION");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const challenge = this.db.prepare(`SELECT c.challenge_id, c.account_id, c.expires_at, c.consumed_at,
        a.wallet, a.role, a.enabled FROM auth_challenges c JOIN accounts a USING(account_id)
        WHERE c.challenge_id = ?`).get(input.challengeId);
      if (!challenge || challenge.consumed_at !== null || Number(challenge.expires_at) <= input.now || Number(challenge.enabled) !== 1) {
        throw new Error("LIBRARY_CHALLENGE_INVALID");
      }
      const consumed = this.db.prepare("UPDATE auth_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?")
        .run(input.now, input.challengeId, input.now);
      if (consumed.changes !== 1) throw new Error("LIBRARY_CHALLENGE_INVALID");
      this.db.prepare("INSERT INTO auth_sessions(token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run(tokenHash, Number(challenge.account_id), input.now, input.expiresAt);
      this.db.exec("COMMIT");
      return { tokenHash, wallet: String(challenge.wallet), role: String(challenge.role) as "STUDENT" | "LIBRARIAN",
        createdAt: input.now, expiresAt: input.expiresAt };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  revokeSession(tokenHash: string, revokedAt: number): boolean {
    const normalizedHash = tokenHash.toLowerCase();
    safeInteger(revokedAt, "INVALID_LIBRARY_TIMESTAMP");
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) return false;
    return this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(revokedAt, normalizedHash).changes === 1;
  }

  consumeAuthRateLimit(input: { scope: "challenge" | "verify"; subjectHash: string; now: number; maxRequests: number; windowSeconds: number }):
    { allowed: boolean; retryAfterSeconds: number } {
    const subjectHash = input.subjectHash.toLowerCase();
    safeInteger(input.now, "INVALID_LIBRARY_TIMESTAMP");
    safeInteger(input.maxRequests, "INVALID_LIBRARY_RATE_LIMIT", 1);
    safeInteger(input.windowSeconds, "INVALID_LIBRARY_RATE_LIMIT", 1);
    if (!/^[0-9a-f]{64}$/.test(subjectHash)) throw new Error("INVALID_LIBRARY_RATE_LIMIT_SUBJECT");
    const windowStartedAt = Math.floor(input.now / input.windowSeconds) * input.windowSeconds;
    const windowEndsAt = windowStartedAt + input.windowSeconds;
    if (!Number.isSafeInteger(windowEndsAt)) throw new Error("INVALID_LIBRARY_TIMESTAMP");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.purgeExpiredAuthRecords(input.now);
      const retention = Math.max(86_400, input.windowSeconds * 2);
      const oldestRetainedWindow = Math.max(0, windowStartedAt - retention);
      this.db.prepare("DELETE FROM auth_rate_limits WHERE window_started_at < ?").run(oldestRetainedWindow);
      const row = this.db.prepare(`SELECT request_count FROM auth_rate_limits
        WHERE scope = ? AND subject_hash = ? AND window_started_at = ?`)
        .get(input.scope, subjectHash, windowStartedAt);
      if (Number(row?.request_count ?? 0) >= input.maxRequests) {
        this.db.exec("COMMIT");
        return { allowed: false, retryAfterSeconds: Math.max(1, windowEndsAt - input.now) };
      }
      this.db.prepare(`INSERT INTO auth_rate_limits(scope, subject_hash, window_started_at, request_count)
        VALUES (?, ?, ?, 1) ON CONFLICT(scope, subject_hash, window_started_at)
        DO UPDATE SET request_count = request_count + 1`)
        .run(input.scope, subjectHash, windowStartedAt);
      this.db.exec("COMMIT");
      return { allowed: true, retryAfterSeconds: 0 };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private purgeExpiredAuthRecords(now: number): void {
    this.db.prepare(`DELETE FROM auth_challenges WHERE challenge_id IN (
      SELECT challenge_id FROM auth_challenges WHERE expires_at <= ? ORDER BY expires_at, challenge_id LIMIT ?)`)
      .run(now, authCleanupBatchSize);
    this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (
      SELECT token_hash FROM auth_sessions WHERE expires_at <= ? ORDER BY expires_at, token_hash LIMIT ?)`)
      .run(now, authCleanupBatchSize);
    this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash IN (
      SELECT token_hash FROM auth_sessions WHERE revoked_at IS NOT NULL ORDER BY revoked_at, token_hash LIMIT ?)`)
      .run(authCleanupBatchSize);
  }

  getSession(tokenHash: string, now: number): LibrarySessionRecord | undefined {
    const normalizedHash = tokenHash.toLowerCase();
    safeInteger(now, "INVALID_LIBRARY_TIMESTAMP");
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) return undefined;
    const row = this.db.prepare(`SELECT s.token_hash, a.wallet, a.role, s.created_at, s.expires_at
      FROM auth_sessions s JOIN accounts a USING(account_id)
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND a.enabled = 1`).get(normalizedHash, now);
    if (!row) return undefined;
    return { tokenHash: String(row.token_hash), wallet: String(row.wallet), role: String(row.role) as "STUDENT" | "LIBRARIAN",
      createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
  }

  setAccountEnabled(walletInput: string, enabled: boolean, changedAt: number): void {
    const wallet = canonicalWallet(walletInput);
    safeInteger(changedAt, "INVALID_LIBRARY_TIMESTAMP");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare("UPDATE accounts SET enabled = ? WHERE wallet = ? COLLATE NOCASE").run(enabled ? 1 : 0, wallet);
      if (changed.changes !== 1) throw new Error("LIBRARY_ACCOUNT_NOT_FOUND");
      if (!enabled) this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE account_id = (SELECT account_id FROM accounts WHERE wallet = ? COLLATE NOCASE) AND revoked_at IS NULL")
        .run(changedAt, wallet);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export type { LibraryAccountSeed, LibraryBookRecord, LibraryDbRefundStatus, LibraryDbRequestStatus, LibraryDemoSeed,
  LibraryChallengeRecord, LibraryDepositProjection, LibraryRequestRecord, LibrarySessionRecord, LibraryVerifiedDeposit } from "./library.types.ts";
