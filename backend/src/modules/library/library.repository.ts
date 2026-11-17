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
  LibrarySettlementIntentRecord,
  LibrarySessionRecord,
  LibraryStoredTransaction,
  LibraryVerifiedChainEvent,
  LibraryVerifiedDeposit,
} from "./library.types.ts";

const addressPattern = /^0x[0-9a-f]{40}$/i;
const bytes32Pattern = /^0x[0-9a-f]{64}$/i;
const integerStringPattern = /^(0|[1-9][0-9]*)$/;
const fixedDepositWei = "50000000000000000000";
const authCleanupBatchSize = 256;
const eventActions = {
  DepositReceived: "deposit",
  LoanApproved: "approve",
  RequestRejected: "reject",
  ExpiredRefundClaimed: "refund",
  PhysicalReturnConfirmed: "confirmReturn",
  ReturnSettled: "return",
  LostSettled: "settle",
  ShortfallPaid: "payShortfall",
} as const;

function librarySqliteBusy(error: unknown): boolean {
  return error instanceof Error && (error.message.toLowerCase().includes("database is locked")
    || ("code" in error && typeof error.code === "string" && /SQLITE_(BUSY|LOCKED)/.test(error.code)));
}

function beginImmediate(db: DatabaseSync): void {
  try { db.exec("BEGIN IMMEDIATE"); }
  catch (error) {
    if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
    throw error;
  }
}

function rollback(db: DatabaseSync): void {
  try { db.exec("ROLLBACK"); } catch { /* preserve the transaction failure */ }
}

function serializedChainEvent(event: LibraryVerifiedChainEvent): string {
  const { observedAt: _observedAt, ...immutable } = event;
  return JSON.stringify(immutable);
}

function chainEventPayloadMatches(payload: string, event: LibraryVerifiedChainEvent): boolean {
  try {
    const stored = JSON.parse(payload) as Record<string, unknown>;
    if (event.eventName === "DepositReceived" && stored.eventName === "DepositReceived" && typeof stored.depositWei === "string") {
      return stored.requestId === event.requestId && String(stored.borrower).toLowerCase() === event.borrower.toLowerCase()
        && String(stored.bookId).toLowerCase() === event.bookId.toLowerCase() && stored.depositWei === event.amountWei
        && stored.approvalDeadline === event.approvalDeadline && stored.chainId === event.chainId
        && String(stored.contractAddress).toLowerCase() === event.contractAddress.toLowerCase()
        && String(stored.txHash).toLowerCase() === event.txHash.toLowerCase() && stored.logIndex === event.logIndex
        && stored.blockNumber === event.blockNumber && String(stored.blockHash).toLowerCase() === event.blockHash.toLowerCase()
        && stored.occurredAt === event.blockTimestamp;
    }
    return serializedChainEvent(stored as unknown as LibraryVerifiedChainEvent) === serializedChainEvent(event);
  } catch { return false; }
}

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
  beginImmediate(db);
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
    rollback(db);
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
    beginImmediate(this.db);
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
      rollback(this.db);
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

  createDepositRequest(input: { requestId: string; wallet: string; bookId: string; idempotencyKey: string; createdAt: number;
    chainTime: number; holdAfterSeconds: number }): LibraryRequestRecord {
    const requestId = canonicalBytes32(input.requestId, "INVALID_LIBRARY_REQUEST_ID");
    const wallet = canonicalWallet(input.wallet);
    const bookId = canonicalBytes32(input.bookId, "INVALID_LIBRARY_BOOK_ID");
    safeInteger(input.createdAt, "INVALID_LIBRARY_TIMESTAMP");
    if (!input.idempotencyKey.trim()) throw new Error("INVALID_LIBRARY_IDEMPOTENCY_KEY");
    safeInteger(input.chainTime, "INVALID_LIBRARY_TIMESTAMP");
    safeInteger(input.holdAfterSeconds, "INVALID_LIBRARY_HOLD_POLICY", 1);
    beginImmediate(this.db);
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
      const accountId = Number(account.account_id);
      const chainTime = input.chainTime;
      const holdAfterSeconds = input.holdAfterSeconds;
      this.db.prepare(`INSERT INTO account_holds(account_id, loan_id, hold_type, started_at)
        SELECT l.account_id, l.loan_id, 'OVERDUE', ? FROM loans l
        WHERE l.account_id = ? AND l.status IN ('ACTIVE', 'RETURN_REQUESTED', 'SETTLEMENT_PENDING') AND ? > l.due_at + ?
        ON CONFLICT(account_id, loan_id, hold_type) DO NOTHING`)
        .run(chainTime, accountId, chainTime, holdAfterSeconds);
      this.db.prepare(`INSERT INTO account_holds(account_id, loan_id, hold_type, started_at)
        SELECT l.account_id, l.loan_id, 'LOST_SHORTFALL', ? FROM loans l
        WHERE l.account_id = ? AND l.status = 'LOST_SHORTFALL_DUE'
        ON CONFLICT(account_id, loan_id, hold_type) DO NOTHING`).run(chainTime, accountId);
      this.db.prepare(`UPDATE account_holds SET released_at = ? WHERE account_id = ? AND released_at IS NULL AND (
        (hold_type = 'OVERDUE' AND (SELECT status FROM loans WHERE loan_id = account_holds.loan_id) NOT IN ('ACTIVE', 'RETURN_REQUESTED', 'SETTLEMENT_PENDING'))
        OR (hold_type = 'LOST_SHORTFALL' AND (SELECT status FROM loans WHERE loan_id = account_holds.loan_id) <> 'LOST_SHORTFALL_DUE'))`)
        .run(chainTime, accountId);
      const blockingHold = this.db.prepare(`SELECT 1 AS found FROM account_holds h
        JOIN loans l USING(loan_id) WHERE h.account_id = ? AND h.released_at IS NULL
        AND ((h.hold_type = 'OVERDUE' AND ? > l.due_at + ?) OR h.hold_type = 'LOST_SHORTFALL') LIMIT 1`)
        .get(accountId, chainTime, holdAfterSeconds);
      if (blockingHold) throw new Error("LIBRARY_ACCOUNT_HELD");
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
      rollback(this.db);
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
    const chainEvent: LibraryVerifiedChainEvent = {
      chainId: 20261, contractAddress: event.contractAddress, txHash: event.txHash, logIndex: event.logIndex,
      blockNumber: event.blockNumber, blockHash: event.blockHash, blockTimestamp: event.occurredAt,
      transactionFrom: event.borrower, observedAt: event.occurredAt, eventName: "DepositReceived",
      requestId: event.requestId, borrower: event.borrower, bookId: event.bookId, amountWei: event.depositWei,
      depositedAt: event.occurredAt, approvalDeadline: event.approvalDeadline,
    };
    const payload = serializedChainEvent(chainEvent);
    beginImmediate(this.db);
    try {
      const previous = this.db.prepare(`SELECT request_id, payload_json FROM chain_events
        WHERE chain_id = ? AND contract_address = ? COLLATE NOCASE AND tx_hash = ? AND log_index = ?`)
        .get(event.chainId, event.contractAddress, event.txHash, event.logIndex);
      if (previous) {
        if (previous.request_id !== event.requestId || !chainEventPayloadMatches(String(previous.payload_json), chainEvent)) throw new Error("LIBRARY_EVENT_CONFLICT");
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
      const inserted = this.db.prepare(`INSERT INTO chain_events(chain_id, contract_address, tx_hash, log_index, block_number, block_hash,
        event_name, request_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.chainId, event.contractAddress, event.txHash, event.logIndex, event.blockNumber, event.blockHash,
          event.eventName, event.requestId, payload, event.occurredAt);
      const eventId = Number(inserted.lastInsertRowid);
      this.db.prepare(`INSERT INTO library_event_canonicality(event_id, status, checked_at, observed_block_hash)
        VALUES (?, 'CANONICAL', ?, ?)`).run(eventId, event.occurredAt, event.blockHash);
      this.db.prepare(`INSERT INTO library_transactions(request_id, action, tx_hash, submitted_at, status, block_number,
        block_hash, log_index, event_name) VALUES (?, 'deposit', ?, ?, 'CONFIRMED', ?, ?, ?, 'DepositReceived')
        ON CONFLICT(request_id, action) DO NOTHING`)
        .run(event.requestId, event.txHash, event.occurredAt, event.blockNumber, event.blockHash, event.logIndex);

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
      rollback(this.db);
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: chain_events")) throw new Error("LIBRARY_EVENT_CONFLICT");
      throw error;
    }
  }

  getRequest(requestId: string): LibraryRequestRecord | undefined {
    const normalized = canonicalBytes32(requestId, "INVALID_LIBRARY_REQUEST_ID");
    return rowToRequest(this.db.prepare(`SELECT r.*, a.wallet FROM borrow_requests r JOIN accounts a USING(account_id)
      WHERE r.request_id = ?`).get(normalized));
  }

  recordVerifiedChainEvents(events: readonly LibraryVerifiedChainEvent[], cursorBlock: number, checkedAt: number,
    policyJson: string, advanceCursor = true): { applied: number; duplicates: number; ignored: number; cursorBlock: number } {
    safeInteger(cursorBlock, "INVALID_LIBRARY_BLOCK_NUMBER");
    safeInteger(checkedAt, "INVALID_LIBRARY_TIMESTAMP");
    if (!policyJson.trim() || policyJson.length > 16_384) throw new Error("INVALID_LIBRARY_POLICY_SNAPSHOT");
    beginImmediate(this.db);
    try {
      const state = this.db.prepare("SELECT cursor_block, health FROM library_reconcile_state WHERE singleton = 1").get();
      if (!state || state.health !== "HEALTHY") throw new Error("LIBRARY_REORG_DETECTED");
      if (cursorBlock < Number(state.cursor_block)) throw new Error("LIBRARY_CURSOR_REGRESSION");
      let applied = 0, duplicates = 0, ignored = 0;
      const ordered = [...events].sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
      for (const source of ordered) {
        const event = { ...source,
          requestId: canonicalBytes32(source.requestId, "INVALID_LIBRARY_REQUEST_ID"),
          borrower: canonicalWallet(source.borrower),
          transactionFrom: canonicalWallet(source.transactionFrom),
          contractAddress: canonicalWallet(source.contractAddress),
          txHash: canonicalBytes32(source.txHash, "INVALID_LIBRARY_TX_HASH"),
          blockHash: canonicalBytes32(source.blockHash, "INVALID_LIBRARY_BLOCK_HASH"),
        } as LibraryVerifiedChainEvent;
        safeInteger(event.logIndex, "INVALID_LIBRARY_LOG_INDEX");
        safeInteger(event.blockNumber, "INVALID_LIBRARY_BLOCK_NUMBER");
        safeInteger(event.blockTimestamp, "INVALID_LIBRARY_TIMESTAMP", 1);
        safeInteger(event.observedAt, "INVALID_LIBRARY_TIMESTAMP");
        if (event.chainId !== 20261 || (advanceCursor && event.blockNumber > cursorBlock)) throw new Error("INVALID_LIBRARY_VERIFIED_EVENT");
        if (event.eventName === "DepositReceived") {
          event.bookId = canonicalBytes32(event.bookId, "INVALID_LIBRARY_BOOK_ID");
          canonicalWei(event.amountWei, true);
          safeInteger(event.depositedAt, "INVALID_LIBRARY_TIMESTAMP", 1);
          safeInteger(event.approvalDeadline, "INVALID_LIBRARY_TIMESTAMP", 1);
        } else if (event.eventName === "LoanApproved") {
          canonicalWei(event.replacementPriceWei, true);
          safeInteger(event.approvedAt, "INVALID_LIBRARY_TIMESTAMP", 1);
          safeInteger(event.dueAt, "INVALID_LIBRARY_TIMESTAMP", 1);
        } else if (event.eventName === "RequestRejected" || event.eventName === "ExpiredRefundClaimed") {
          canonicalWei(event.refundWei);
        } else if (event.eventName === "PhysicalReturnConfirmed") {
          safeInteger(event.returnedAt, "INVALID_LIBRARY_TIMESTAMP", 1);
        } else if (event.eventName === "ReturnSettled") {
          safeInteger(event.returnedAt, "INVALID_LIBRARY_TIMESTAMP", 1);
          canonicalWei(event.lateFeeWei); canonicalWei(event.repairFeeWei); canonicalWei(event.overdueForfeitWei);
          canonicalWei(event.totalRetainedWei); canonicalWei(event.refundWei);
        } else if (event.eventName === "LostSettled") {
          canonicalWei(event.replacementPriceWei, true); canonicalWei(event.retainedWei); canonicalWei(event.refundWei);
          canonicalWei(event.shortfallWei);
        } else if (event.eventName === "ShortfallPaid") canonicalWei(event.amountWei, true);

        const previous = this.db.prepare(`SELECT e.event_id, e.request_id, e.payload_json, c.status
          FROM chain_events e LEFT JOIN library_event_canonicality c USING(event_id)
          WHERE e.chain_id = ? AND e.contract_address = ? COLLATE NOCASE AND e.tx_hash = ? AND e.log_index = ?`)
          .get(event.chainId, event.contractAddress, event.txHash, event.logIndex);
        if (previous) {
          if (previous.request_id !== event.requestId || !chainEventPayloadMatches(String(previous.payload_json), event)) throw new Error("LIBRARY_EVENT_CONFLICT");
          if (previous.status !== "CANONICAL") throw new Error("LIBRARY_REORG_DETECTED");
          duplicates++;
          continue;
        }
        const request = this.db.prepare(`SELECT r.request_id, r.account_id, r.book_id, r.copy_id, r.status, r.refund_status,
          r.deposit_wei, r.approval_deadline, a.wallet, b.deposit_wei AS book_deposit_wei,
          b.replacement_price_wei, l.status AS loan_status, l.deposit_wei AS loan_deposit_wei,
          l.replacement_price_wei AS loan_replacement_price_wei, l.return_received_at, l.due_at
          FROM borrow_requests r JOIN accounts a USING(account_id) JOIN books b USING(book_id)
          LEFT JOIN loans l ON l.request_id = r.request_id WHERE r.request_id = ?`).get(event.requestId);
        if (!request) { ignored++; continue; }
        const unmatched = this.db.prepare("SELECT * FROM library_unmatched_deposits WHERE request_id = ?").get(event.requestId);
        const mismatch = String(request.wallet).toLowerCase() !== event.borrower
          || (event.eventName === "DepositReceived" && String(request.book_id) !== event.bookId);
        if (mismatch && event.eventName !== "DepositReceived" && !unmatched) {
          throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
        }
        const payload = serializedChainEvent(event);
        const inserted = this.db.prepare(`INSERT INTO chain_events(chain_id, contract_address, tx_hash, log_index, block_number,
          block_hash, event_name, request_id, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(event.chainId, event.contractAddress, event.txHash, event.logIndex, event.blockNumber, event.blockHash,
            event.eventName, event.requestId, payload, event.blockTimestamp);
        const eventId = Number(inserted.lastInsertRowid);
        this.db.prepare(`INSERT INTO library_event_canonicality(event_id, status, checked_at, observed_block_hash)
          VALUES (?, 'CANONICAL', ?, ?)`).run(eventId, checkedAt, event.blockHash);

        if (unmatched || mismatch) {
          if (event.eventName === "DepositReceived" && !unmatched) {
            this.db.prepare(`INSERT INTO library_unmatched_deposits(request_id, borrower, book_id, amount_wei,
              approval_deadline, deposit_event_id, latest_event_name) VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(event.requestId, event.borrower, event.bookId, event.amountWei, event.approvalDeadline, eventId, event.eventName);
          } else if (unmatched) {
            if (String(unmatched.borrower) !== event.borrower) throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            const refunded = event.eventName === "RequestRejected" || event.eventName === "ExpiredRefundClaimed";
            if (refunded && event.refundWei !== String(unmatched.amount_wei)) throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            this.db.prepare(`UPDATE library_unmatched_deposits SET latest_event_name = ?,
              refund_event_id = coalesce(?, refund_event_id) WHERE request_id = ?`)
              .run(event.eventName, refunded ? eventId : null, event.requestId);
            if (refunded) this.db.prepare(`UPDATE library_unmatched_refund_attempts SET status = 'CONFIRMED',
              block_number = ?, block_hash = ? WHERE tx_hash = ? AND request_id = ?`)
              .run(event.blockNumber, event.blockHash, event.txHash, event.requestId);
          }
          ignored++;
          continue;
        }

        const releaseCopy = (copyId: unknown, fromStatus: string) => {
          if (typeof copyId !== "string") throw new Error("LIBRARY_EVENT_COPY_MISSING");
          const result = this.db.prepare("UPDATE book_copies SET status = 'AVAILABLE' WHERE copy_id = ? AND status = ?")
            .run(copyId, fromStatus);
          if (result.changes !== 1) throw new Error("LIBRARY_EVENT_COPY_CONFLICT");
        };
        const privileged = ["LoanApproved", "RequestRejected", "PhysicalReturnConfirmed", "ReturnSettled", "LostSettled"]
          .includes(event.eventName);
        const actor = this.db.prepare("SELECT account_id, role FROM accounts WHERE wallet = ? COLLATE NOCASE")
          .get(event.transactionFrom);
        if (privileged && (!actor || actor.role !== "LIBRARIAN")) throw new Error("LIBRARY_EVENT_ACTOR_MISMATCH");
        const action = eventActions[event.eventName];
        const previousTx = this.db.prepare(`SELECT tx_hash, status, settlement_intent_id FROM library_transactions
          WHERE request_id = ? AND action = ?`).get(event.requestId, action);
        const samePreviousTx = previousTx && String(previousTx.tx_hash).toLowerCase() === event.txHash;
        const previousAttempt = this.db.prepare(`SELECT request_id, action, submitted_at, settlement_intent_id FROM library_transaction_attempts
          WHERE tx_hash = ?`).get(event.txHash);
        if (previousAttempt && (String(previousAttempt.request_id) !== event.requestId || String(previousAttempt.action) !== action)) {
          throw new Error("LIBRARY_TRANSACTION_CONFLICT");
        }
        if (previousTx && !samePreviousTx && String(previousTx.status) === "CONFIRMED") {
          throw new Error("LIBRARY_TRANSACTION_CONFLICT");
        }
        const eventSettlementIntentId = samePreviousTx ? previousTx.settlement_intent_id : previousAttempt?.settlement_intent_id;
        const settlementIntentFor = (outcome: "RETURNED" | "LOST") => {
          const intentId = eventSettlementIntentId;
          if (typeof intentId !== "string") return undefined;
          const intent = this.db.prepare(`SELECT intent_id, reason FROM settlement_intents WHERE intent_id = ?
            AND request_id = ? AND outcome = ? AND librarian_account_id = ?`).get(intentId, event.requestId, outcome, Number(actor?.account_id));
          if (!intent) throw new Error("LIBRARY_SETTLEMENT_INTENT_MISMATCH");
          return { intentId: String(intent.intent_id), reason: String(intent.reason) };
        };

        switch (event.eventName) {
          case "DepositReceived": {
            if (request.status !== "AWAITING_DEPOSIT" || String(request.book_id) !== event.bookId
              || String(request.book_deposit_wei) !== event.amountWei || event.depositedAt !== event.blockTimestamp
              || event.approvalDeadline <= event.depositedAt) throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            const copy = this.db.prepare(`SELECT copy_id FROM book_copies WHERE book_id = ? AND status = 'AVAILABLE'
              ORDER BY barcode, copy_id LIMIT 1`).get(event.bookId);
            if (copy) {
              const copyId = String(copy.copy_id);
              if (this.db.prepare("UPDATE book_copies SET status = 'PENDING_APPROVAL' WHERE copy_id = ? AND status = 'AVAILABLE'")
                .run(copyId).changes !== 1) throw new Error("LIBRARY_COPY_ALLOCATION_CONFLICT");
              this.db.prepare(`UPDATE borrow_requests SET copy_id = ?, status = 'PENDING_APPROVAL', refund_status = 'NONE',
                deposit_wei = ?, approval_deadline = ?, chain_id = ?, contract_address = ?, deposit_tx_hash = ?, updated_at = ?
                WHERE request_id = ? AND status = 'AWAITING_DEPOSIT'`)
                .run(copyId, event.amountWei, event.approvalDeadline, event.chainId, event.contractAddress, event.txHash, event.blockTimestamp, event.requestId);
            } else {
              this.db.prepare(`UPDATE borrow_requests SET status = 'REJECTED_NO_COPY', refund_status = 'REFUND_DUE', deposit_wei = ?,
                approval_deadline = ?, chain_id = ?, contract_address = ?, deposit_tx_hash = ?, updated_at = ?
                WHERE request_id = ? AND status = 'AWAITING_DEPOSIT'`)
                .run(event.amountWei, event.approvalDeadline, event.chainId, event.contractAddress, event.txHash, event.blockTimestamp, event.requestId);
            }
            break;
          }
          case "LoanApproved": {
            if (request.status !== "PENDING_APPROVAL" || request.copy_id === null || request.approval_deadline === null
              || event.approvedAt !== event.blockTimestamp || event.approvedAt >= Number(request.approval_deadline)
              || event.dueAt <= event.approvedAt || String(request.replacement_price_wei) !== event.replacementPriceWei) {
              throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            }
            if (this.db.prepare("UPDATE book_copies SET status = 'ON_LOAN' WHERE copy_id = ? AND status = 'PENDING_APPROVAL'")
              .run(String(request.copy_id)).changes !== 1) throw new Error("LIBRARY_EVENT_COPY_CONFLICT");
            this.db.prepare(`UPDATE borrow_requests SET status = 'APPROVED', updated_at = ? WHERE request_id = ?`)
              .run(event.blockTimestamp, event.requestId);
            this.db.prepare(`INSERT INTO loans(loan_id, request_id, book_id, copy_id, account_id, status, deposit_wei,
              replacement_price_wei, policy_json, approved_at, due_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`)
              .run(event.requestId, event.requestId, request.book_id, request.copy_id, request.account_id,
                request.deposit_wei, event.replacementPriceWei, policyJson, event.approvedAt, event.dueAt, event.blockTimestamp, event.blockTimestamp);
            break;
          }
          case "RequestRejected": {
            const hasHeldCopy = request.status === "PENDING_APPROVAL" && request.copy_id !== null;
            const isNoCopyRefund = request.status === "REJECTED_NO_COPY" && request.copy_id === null;
            const expiredRefundDue = request.status === "EXPIRED_REFUND_DUE" && request.refund_status === "REFUND_DUE"
              && request.copy_id === null && request.approval_deadline !== null && event.blockTimestamp >= Number(request.approval_deadline);
            if ((!hasHeldCopy && !isNoCopyRefund && !expiredRefundDue) || String(request.deposit_wei) !== event.refundWei) {
              throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            }
            if (hasHeldCopy) releaseCopy(request.copy_id!, "PENDING_APPROVAL");
            this.db.prepare("UPDATE borrow_requests SET status = 'REJECTED', refund_status = 'REFUNDED', updated_at = ? WHERE request_id = ?")
              .run(event.blockTimestamp, event.requestId);
            break;
          }
          case "ExpiredRefundClaimed": {
            if (!["PENDING_APPROVAL", "REJECTED_NO_COPY", "EXPIRED_REFUND_DUE"].includes(String(request.status))
              || String(request.deposit_wei) !== event.refundWei || request.approval_deadline === null
              || event.blockTimestamp < Number(request.approval_deadline)) throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            if (request.status === "PENDING_APPROVAL") releaseCopy(request.copy_id, "PENDING_APPROVAL");
            this.db.prepare(`UPDATE borrow_requests SET copy_id = NULL, status = CASE WHEN status = 'PENDING_APPROVAL' THEN 'EXPIRED_REFUND_DUE' ELSE status END,
              refund_status = 'REFUNDED', updated_at = ? WHERE request_id = ?`)
              .run(event.blockTimestamp, event.requestId);
            break;
          }
          case "PhysicalReturnConfirmed": {
            if (!["ACTIVE", "RETURN_REQUESTED"].includes(String(request.loan_status)) || event.returnedAt !== event.blockTimestamp) {
              throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            }
            if (this.db.prepare("UPDATE book_copies SET status = 'RETURN_REVIEW' WHERE copy_id = ? AND status = 'ON_LOAN'")
              .run(String(request.copy_id)).changes !== 1) throw new Error("LIBRARY_EVENT_COPY_CONFLICT");
            this.db.prepare("UPDATE loans SET status = 'SETTLEMENT_PENDING', return_received_at = ?, updated_at = ? WHERE request_id = ?")
              .run(event.returnedAt, event.blockTimestamp, event.requestId);
            this.db.prepare("UPDATE borrow_requests SET status = 'SETTLEMENT_PENDING', updated_at = ? WHERE request_id = ?")
              .run(event.blockTimestamp, event.requestId);
            break;
          }
          case "ReturnSettled": {
            if (request.loan_status !== "SETTLEMENT_PENDING" || Number(request.return_received_at) !== event.returnedAt) {
              throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            }
            const actorId = Number(actor?.account_id);
            const intent = settlementIntentFor("RETURNED");
            this.db.prepare(`INSERT INTO settlements(loan_id, outcome, reason, retained_wei, refund_wei, shortfall_wei,
              librarian_account_id, tx_hash, event_id, created_at, settlement_intent_id)
              VALUES (?, 'RETURNED', ?, ?, ?, '0', ?, ?, ?, ?, ?)`)
              .run(event.requestId, intent?.reason ?? "Verified on-chain settlement", event.totalRetainedWei, event.refundWei,
                actorId, event.txHash, eventId, event.blockTimestamp, intent?.intentId ?? null);
            if (this.db.prepare(`UPDATE book_copies SET status = ? WHERE copy_id = ? AND status = 'RETURN_REVIEW'`)
              .run(event.maintenanceRequired ? "MAINTENANCE" : "AVAILABLE", String(request.copy_id)).changes !== 1) {
              throw new Error("LIBRARY_EVENT_COPY_CONFLICT");
            }
            this.db.prepare("UPDATE loans SET status = 'RETURNED', updated_at = ? WHERE request_id = ?")
              .run(event.blockTimestamp, event.requestId);
            this.db.prepare("UPDATE borrow_requests SET status = 'RETURNED', updated_at = ? WHERE request_id = ?")
              .run(event.blockTimestamp, event.requestId);
            break;
          }
          case "LostSettled": {
            if (!["ACTIVE", "RETURN_REQUESTED"].includes(String(request.loan_status))
              || event.replacementPriceWei !== String(request.loan_replacement_price_wei)) throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            const depositAmount = BigInt(String(request.loan_deposit_wei));
            const replacement = BigInt(event.replacementPriceWei);
            if (BigInt(event.retainedWei) !== (replacement < depositAmount ? replacement : depositAmount)
              || BigInt(event.refundWei) !== (depositAmount > replacement ? depositAmount - replacement : 0n)
              || BigInt(event.shortfallWei) !== (replacement > depositAmount ? replacement - depositAmount : 0n)) {
              throw new Error("LIBRARY_EVENT_SETTLEMENT_MISMATCH");
            }
            const actorId = Number(actor?.account_id);
            const intent = settlementIntentFor("LOST");
            this.db.prepare(`INSERT INTO settlements(loan_id, outcome, reason, retained_wei, refund_wei, shortfall_wei,
              librarian_account_id, tx_hash, event_id, created_at, settlement_intent_id)
              VALUES (?, 'LOST', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(event.requestId, intent?.reason ?? "Verified on-chain settlement", event.retainedWei, event.refundWei,
                event.shortfallWei, actorId, event.txHash, eventId, event.blockTimestamp, intent?.intentId ?? null);
            const status = BigInt(event.shortfallWei) > 0n ? "LOST_SHORTFALL_DUE" : "LOST_SETTLED";
            if (this.db.prepare("UPDATE book_copies SET status = 'LOST' WHERE copy_id = ? AND status = 'ON_LOAN'")
              .run(String(request.copy_id)).changes !== 1) throw new Error("LIBRARY_EVENT_COPY_CONFLICT");
            this.db.prepare("UPDATE loans SET status = ?, updated_at = ? WHERE request_id = ?")
              .run(status, event.blockTimestamp, event.requestId);
            this.db.prepare("UPDATE borrow_requests SET status = ?, updated_at = ? WHERE request_id = ?")
              .run(status, event.blockTimestamp, event.requestId);
            break;
          }
          case "ShortfallPaid": {
            const due = this.db.prepare("SELECT shortfall_wei FROM settlements WHERE loan_id = ? AND outcome = 'LOST'")
              .get(event.requestId)?.shortfall_wei;
            if (request.loan_status !== "LOST_SHORTFALL_DUE" || due === undefined || String(due) !== event.amountWei) {
              throw new Error("LIBRARY_EVENT_REQUEST_MISMATCH");
            }
            this.db.prepare("UPDATE loans SET status = 'LOST_SETTLED', updated_at = ? WHERE request_id = ?")
              .run(event.blockTimestamp, event.requestId);
            this.db.prepare("UPDATE borrow_requests SET status = 'LOST_SETTLED', updated_at = ? WHERE request_id = ?")
              .run(event.blockTimestamp, event.requestId);
            this.db.prepare("UPDATE account_holds SET released_at = ? WHERE loan_id = ? AND hold_type = 'LOST_SHORTFALL' AND released_at IS NULL")
              .run(event.blockTimestamp, event.requestId);
            break;
          }
        }

        const submittedAt = Number(previousAttempt?.submitted_at ?? event.observedAt);
        this.db.prepare(`INSERT INTO library_transactions(request_id, action, tx_hash, submitted_at, status, block_number,
          block_hash, log_index, event_name, settlement_intent_id) VALUES (?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?)
          ON CONFLICT(request_id, action) DO UPDATE SET tx_hash = excluded.tx_hash, submitted_at = excluded.submitted_at,
            status = 'CONFIRMED', block_number = excluded.block_number, block_hash = excluded.block_hash,
            log_index = excluded.log_index, event_name = excluded.event_name, settlement_intent_id = excluded.settlement_intent_id`)
          .run(event.requestId, action, event.txHash, submittedAt, event.blockNumber, event.blockHash, event.logIndex,
            event.eventName, eventSettlementIntentId ?? null);
        this.db.prepare(`INSERT INTO library_transaction_attempts(tx_hash, request_id, action, submitted_at, status,
          block_number, block_hash, log_index, event_name, settlement_intent_id)
          VALUES (?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?)
          ON CONFLICT(tx_hash) DO UPDATE SET status = 'CONFIRMED', block_number = excluded.block_number,
            block_hash = excluded.block_hash, log_index = excluded.log_index, event_name = excluded.event_name,
            settlement_intent_id = coalesce(library_transaction_attempts.settlement_intent_id, excluded.settlement_intent_id)`)
          .run(event.txHash, event.requestId, action, submittedAt, event.blockNumber, event.blockHash, event.logIndex,
            event.eventName, eventSettlementIntentId ?? null);
        if (actor) this.db.prepare(`INSERT INTO audit_log(actor_account_id, actor_role, action, target_type, target_id, created_at)
          VALUES (?, ?, ?, 'request', ?, ?)`).run(Number(actor.account_id), String(actor.role), event.eventName, event.requestId, event.blockTimestamp);
        applied++;
      }
      this.db.prepare(`UPDATE library_reconcile_state SET cursor_block = ?, checked_at = ? WHERE singleton = 1`)
        .run(advanceCursor ? cursorBlock : Number(state.cursor_block), checkedAt);
      this.db.exec("COMMIT");
      return { applied, duplicates, ignored, cursorBlock };
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
  }

  reconcileState(): { cursorBlock: number; checkedAt: number; health: "HEALTHY" | "REORG_DETECTED"; errorCode: string | null } {
    const row = this.db.prepare("SELECT cursor_block, checked_at, health, error_code FROM library_reconcile_state WHERE singleton = 1").get();
    if (!row) throw new Error("LIBRARY_RECONCILE_STATE_MISSING");
    return { cursorBlock: Number(row.cursor_block), checkedAt: Number(row.checked_at),
      health: String(row.health) as "HEALTHY" | "REORG_DETECTED", errorCode: row.error_code === null ? null : String(row.error_code) };
  }

  initializeReconcileCursor(deploymentBlock: number, checkedAt: number): void {
    safeInteger(deploymentBlock, "INVALID_LIBRARY_BLOCK_NUMBER", 1);
    safeInteger(checkedAt, "INVALID_LIBRARY_TIMESTAMP");
    beginImmediate(this.db);
    try {
      const existing = this.db.prepare("SELECT cursor_block FROM library_reconcile_state WHERE singleton = 1").get();
      const event = this.db.prepare("SELECT 1 AS found FROM chain_events LIMIT 1").get();
      if (Number(existing?.cursor_block) === 0 && !event) {
        this.db.prepare("UPDATE library_reconcile_state SET cursor_block = ?, checked_at = ? WHERE singleton = 1")
          .run(deploymentBlock - 1, checkedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
  }

  eventCanonicalityCandidates(limit: number, afterEventId = 0): Array<{ eventId: number; blockNumber: number; blockHash: string }> {
    safeInteger(limit, "INVALID_LIBRARY_BATCH_SIZE", 1);
    safeInteger(afterEventId, "INVALID_LIBRARY_EVENT_ID");
    const rows = this.db.prepare(`SELECT e.event_id, e.block_number, e.block_hash FROM chain_events e
      JOIN library_event_canonicality c USING(event_id) WHERE c.status = 'CANONICAL' AND e.event_id > ?
      ORDER BY e.event_id LIMIT ?`).all(afterEventId, limit);
    return rows.map((row) => ({ eventId: Number(row.event_id), blockNumber: Number(row.block_number), blockHash: String(row.block_hash) }));
  }

  canonicalityCursor(): number {
    const row = this.db.prepare("SELECT canonicality_cursor_event_id FROM library_reconcile_state WHERE singleton = 1").get();
    if (!row) throw new Error("LIBRARY_RECONCILE_STATE_MISSING");
    return Number(row.canonicality_cursor_event_id);
  }

  advanceCanonicalityCursor(eventId: number): void {
    safeInteger(eventId, "INVALID_LIBRARY_EVENT_ID");
    beginImmediate(this.db);
    try {
      const state = this.db.prepare("SELECT canonicality_cursor_event_id FROM library_reconcile_state WHERE singleton = 1").get();
      if (!state) throw new Error("LIBRARY_RECONCILE_STATE_MISSING");
      const exists = this.db.prepare(`SELECT 1 AS found FROM library_event_canonicality
        WHERE event_id = ? AND status = 'CANONICAL'`).get(eventId);
      if (!exists) throw new Error("LIBRARY_EVENT_CANONICALITY_NOT_FOUND");
      this.db.prepare("UPDATE library_reconcile_state SET canonicality_cursor_event_id = ? WHERE singleton = 1").run(eventId);
      this.db.exec("COMMIT");
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
  }

  markEventOrphaned(input: { eventId: number; observedBlockHash: string; checkedAt: number }): void {
    safeInteger(input.eventId, "INVALID_LIBRARY_EVENT_ID", 1);
    safeInteger(input.checkedAt, "INVALID_LIBRARY_TIMESTAMP");
    const observedBlockHash = canonicalBytes32(input.observedBlockHash, "INVALID_LIBRARY_BLOCK_HASH");
    beginImmediate(this.db);
    try {
      const changed = this.db.prepare(`UPDATE library_event_canonicality SET status = 'ORPHANED', checked_at = ?, observed_block_hash = ?
        WHERE event_id = ? AND status = 'CANONICAL'`).run(input.checkedAt, observedBlockHash, input.eventId);
      if (changed.changes !== 1) throw new Error("LIBRARY_EVENT_CANONICALITY_NOT_FOUND");
      this.db.prepare("UPDATE library_reconcile_state SET health = 'REORG_DETECTED', error_code = 'CHAIN_REORG' WHERE singleton = 1").run();
      this.db.exec("COMMIT");
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
  }

  recordTransactionSubmission(input: { requestId: string; action: LibraryStoredTransaction["action"]; txHash: string; submittedAt: number;
    settlementIntentId?: string; librarianWallet?: string }): LibraryStoredTransaction {
    const requestId = canonicalBytes32(input.requestId, "INVALID_LIBRARY_REQUEST_ID");
    const txHash = canonicalBytes32(input.txHash, "INVALID_LIBRARY_TX_HASH");
    safeInteger(input.submittedAt, "INVALID_LIBRARY_TIMESTAMP");
    if (!Object.values(eventActions).includes(input.action)) throw new Error("INVALID_LIBRARY_ACTION");
    const expectedOutcome = input.action === "return" ? "RETURNED" : input.action === "settle" ? "LOST" : undefined;
    let settlementIntent: { intentId: string; reason: string } | undefined;
    let settlementIntentId: string | undefined;
    let librarianWallet: string | undefined;
    if (expectedOutcome) {
      if (!input.settlementIntentId || !input.librarianWallet) throw new Error("LIBRARY_SETTLEMENT_INTENT_MISSING");
      librarianWallet = canonicalWallet(input.librarianWallet);
      settlementIntentId = input.settlementIntentId.trim();
      if (!settlementIntentId || settlementIntentId.length > 200) throw new Error("INVALID_LIBRARY_SETTLEMENT_INTENT");
    } else if (input.settlementIntentId !== undefined || input.librarianWallet !== undefined) {
      throw new Error("INVALID_LIBRARY_SETTLEMENT_INTENT");
    }
    beginImmediate(this.db);
    try {
      const request = this.getRequest(requestId);
      if (!request) throw new Error("LIBRARY_REQUEST_NOT_FOUND");
      if (expectedOutcome) {
        const intent = this.db.prepare(`SELECT i.intent_id, i.reason FROM settlement_intents i
          JOIN accounts a ON a.account_id = i.librarian_account_id
          WHERE i.intent_id = ? AND i.request_id = ? AND i.outcome = ? AND a.wallet = ? COLLATE NOCASE`)
          .get(settlementIntentId!, requestId, expectedOutcome, librarianWallet!);
        if (!intent) throw new Error("LIBRARY_SETTLEMENT_INTENT_MISMATCH");
        settlementIntent = { intentId: String(intent.intent_id), reason: String(intent.reason) };
      }
      const existing = this.db.prepare("SELECT tx_hash, status, settlement_intent_id FROM library_transactions WHERE request_id = ? AND action = ?")
        .get(requestId, input.action);
      const sameCurrentTx = existing && String(existing.tx_hash).toLowerCase() === txHash;
      const priorAttempt = this.db.prepare("SELECT request_id, action FROM library_transaction_attempts WHERE tx_hash = ?").get(txHash);
      if (priorAttempt && (String(priorAttempt.request_id) !== requestId || String(priorAttempt.action) !== input.action)) {
        throw new Error("LIBRARY_TRANSACTION_CONFLICT");
      }
      if (existing && !sameCurrentTx && (String(existing.status) !== "REVERTED" || priorAttempt)) {
        throw new Error("LIBRARY_TRANSACTION_CONFLICT");
      }
      if (sameCurrentTx && existing?.settlement_intent_id
        && existing.settlement_intent_id !== (settlementIntent?.intentId ?? null)) {
        throw new Error("LIBRARY_TRANSACTION_CONFLICT");
      }
      this.db.prepare(`INSERT INTO library_transactions(request_id, action, tx_hash, submitted_at, status, settlement_intent_id)
        VALUES (?, ?, ?, ?, 'SUBMITTED', ?) ON CONFLICT(request_id, action) DO UPDATE
        SET tx_hash = excluded.tx_hash, submitted_at = excluded.submitted_at,
          status = CASE WHEN library_transactions.tx_hash = excluded.tx_hash THEN library_transactions.status ELSE 'SUBMITTED' END,
          block_number = CASE WHEN library_transactions.tx_hash = excluded.tx_hash THEN library_transactions.block_number ELSE NULL END,
          block_hash = CASE WHEN library_transactions.tx_hash = excluded.tx_hash THEN library_transactions.block_hash ELSE NULL END,
          log_index = CASE WHEN library_transactions.tx_hash = excluded.tx_hash THEN library_transactions.log_index ELSE NULL END,
          event_name = CASE WHEN library_transactions.tx_hash = excluded.tx_hash THEN library_transactions.event_name ELSE NULL END,
          settlement_intent_id = CASE WHEN library_transactions.tx_hash = excluded.tx_hash
            THEN coalesce(library_transactions.settlement_intent_id, excluded.settlement_intent_id)
            ELSE excluded.settlement_intent_id END`)
        .run(requestId, input.action, txHash, input.submittedAt, settlementIntent?.intentId ?? null);
      this.db.prepare(`INSERT INTO library_transaction_attempts(tx_hash, request_id, action, submitted_at, status, settlement_intent_id)
        VALUES (?, ?, ?, ?, 'SUBMITTED', ?) ON CONFLICT(tx_hash) DO UPDATE
        SET settlement_intent_id = coalesce(library_transaction_attempts.settlement_intent_id, excluded.settlement_intent_id)`)
        .run(txHash, requestId, input.action, input.submittedAt, settlementIntent?.intentId ?? null);
      if (settlementIntent) {
        const outcome = expectedOutcome!;
        const existingSettlement = this.db.prepare(`SELECT outcome, settlement_intent_id FROM settlements
          WHERE loan_id = ? AND tx_hash = ?`).get(requestId, txHash);
        if (existingSettlement) {
          if (existingSettlement.outcome !== outcome
            || (existingSettlement.settlement_intent_id && existingSettlement.settlement_intent_id !== settlementIntent.intentId)) {
            throw new Error("LIBRARY_TRANSACTION_CONFLICT");
          }
          this.db.prepare(`UPDATE settlements SET settlement_intent_id = ?, reason = ? WHERE loan_id = ? AND tx_hash = ? AND outcome = ?`)
            .run(settlementIntent.intentId, settlementIntent.reason, requestId, txHash, outcome);
        }
      }
      const result = this.getTransaction(requestId, input.action);
      if (!result) throw new Error("LIBRARY_TRANSACTION_WRITE_FAILED");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
  }

  listTransactions(requestIdInput: string): LibraryStoredTransaction[] {
    const requestId = canonicalBytes32(requestIdInput, "INVALID_LIBRARY_REQUEST_ID");
    const rows = this.db.prepare(`SELECT t.*, 0 AS attempt_order FROM library_transactions t WHERE request_id = ?
      UNION ALL SELECT a.request_id, a.action, a.tx_hash, a.submitted_at, a.status, a.block_number,
      a.block_hash, a.log_index, a.event_name, a.settlement_intent_id, 1 AS attempt_order FROM library_transaction_attempts a WHERE request_id = ?
      AND NOT EXISTS (SELECT 1 FROM library_transactions t WHERE t.tx_hash = a.tx_hash)
      ORDER BY attempt_order, submitted_at, action, tx_hash` ).all(requestId, requestId);
    return rows.map((row) => ({ requestId, action: String(row.action) as LibraryStoredTransaction["action"], txHash: String(row.tx_hash),
      settlementIntentId: row.settlement_intent_id === null ? null : String(row.settlement_intent_id),
      status: String(row.status) as LibraryStoredTransaction["status"], submittedAt: Number(row.submitted_at),
      blockNumber: row.block_number === null ? null : Number(row.block_number), blockHash: row.block_hash === null ? null : String(row.block_hash),
      logIndex: row.log_index === null ? null : Number(row.log_index), eventName: row.event_name === null ? null : String(row.event_name) }));
  }

  getTransaction(requestId: string, action: LibraryStoredTransaction["action"]): LibraryStoredTransaction | undefined {
    const row = this.db.prepare("SELECT * FROM library_transactions WHERE request_id = ? AND action = ?").get(requestId, action);
    if (!row) return undefined;
    return { requestId, action, txHash: String(row.tx_hash),
      settlementIntentId: row.settlement_intent_id === null ? null : String(row.settlement_intent_id),
      status: String(row.status) as LibraryStoredTransaction["status"],
      submittedAt: Number(row.submitted_at), blockNumber: row.block_number === null ? null : Number(row.block_number),
      blockHash: row.block_hash === null ? null : String(row.block_hash), logIndex: row.log_index === null ? null : Number(row.log_index),
      eventName: row.event_name === null ? null : String(row.event_name) };
  }

  pendingTransactions(limit = 100): LibraryStoredTransaction[] {
    safeInteger(limit, "INVALID_LIBRARY_BATCH_SIZE", 1);
    beginImmediate(this.db);
    try {
      const cursor = String(this.db.prepare("SELECT pending_transaction_cursor FROM library_reconcile_state WHERE singleton = 1").get()
        ?.pending_transaction_cursor ?? "");
      let rows = this.db.prepare(`SELECT * FROM library_transaction_attempts WHERE status = 'SUBMITTED' AND tx_hash > ?
        ORDER BY tx_hash LIMIT ?`).all(cursor, limit);
      if (rows.length === 0 && cursor !== "") {
        rows = this.db.prepare(`SELECT * FROM library_transaction_attempts WHERE status = 'SUBMITTED'
          ORDER BY tx_hash LIMIT ?`).all(limit);
      }
      if (rows.length > 0) {
        this.db.prepare("UPDATE library_reconcile_state SET pending_transaction_cursor = ? WHERE singleton = 1")
          .run(String(rows.at(-1)!.tx_hash));
      }
      this.db.exec("COMMIT");
      return rows.map((row) => ({ requestId: String(row.request_id), action: String(row.action) as LibraryStoredTransaction["action"],
        txHash: String(row.tx_hash), settlementIntentId: row.settlement_intent_id === null ? null : String(row.settlement_intent_id),
        status: "SUBMITTED", submittedAt: Number(row.submitted_at), blockNumber: null,
        blockHash: null, logIndex: null, eventName: null }));
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
  }

  markTransactionReverted(input: { requestId: string; action: LibraryStoredTransaction["action"]; txHash: string;
    blockNumber: number; blockHash: string; checkedAt: number }): LibraryStoredTransaction {
    const requestId = canonicalBytes32(input.requestId, "INVALID_LIBRARY_REQUEST_ID");
    const txHash = canonicalBytes32(input.txHash, "INVALID_LIBRARY_TX_HASH");
    const blockHash = canonicalBytes32(input.blockHash, "INVALID_LIBRARY_BLOCK_HASH");
    safeInteger(input.blockNumber, "INVALID_LIBRARY_BLOCK_NUMBER");
    safeInteger(input.checkedAt, "INVALID_LIBRARY_TIMESTAMP");
    beginImmediate(this.db);
    try {
      const changed = this.db.prepare(`UPDATE library_transactions SET status = 'REVERTED', block_number = ?, block_hash = ?
        WHERE request_id = ? AND action = ? AND tx_hash = ? AND status = 'SUBMITTED'`)
        .run(input.blockNumber, blockHash, requestId, input.action, txHash);
      if (changed.changes !== 1) {
        const existing = this.getTransaction(requestId, input.action);
        if (!existing || (existing.txHash === txHash && existing.status !== "REVERTED")) throw new Error("LIBRARY_TRANSACTION_CONFLICT");
      }
      const attemptChanged = this.db.prepare(`UPDATE library_transaction_attempts SET status = 'REVERTED', block_number = ?,
        block_hash = ? WHERE tx_hash = ? AND request_id = ? AND action = ? AND status = 'SUBMITTED'`)
        .run(input.blockNumber, blockHash, txHash, requestId, input.action);
      if (attemptChanged.changes !== 1) {
        const attempt = this.db.prepare(`SELECT status, block_number, block_hash FROM library_transaction_attempts
          WHERE tx_hash = ? AND request_id = ? AND action = ?`).get(txHash, requestId, input.action);
        if (!attempt || attempt.status !== "REVERTED" || Number(attempt.block_number) !== input.blockNumber
          || String(attempt.block_hash).toLowerCase() !== blockHash) throw new Error("LIBRARY_TRANSACTION_CONFLICT");
      }
      const result = this.getTransactionAttempt(requestId, input.action, txHash);
      if (!result) throw new Error("LIBRARY_TRANSACTION_NOT_FOUND");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
  }

  getTransactionAttempt(requestId: string, action: LibraryStoredTransaction["action"], txHash: string): LibraryStoredTransaction | undefined {
    return this.listTransactions(requestId).find(item => item.action === action && item.txHash.toLowerCase() === txHash.toLowerCase());
  }

  unmatchedDeposits(filter: { requestId?: string; borrower?: string } = {}) {
    const requestId = filter.requestId === undefined ? null : canonicalBytes32(filter.requestId, "INVALID_LIBRARY_REQUEST_ID");
    const borrower = filter.borrower === undefined ? null : canonicalWallet(filter.borrower);
    return this.db.prepare(`SELECT u.*, d.payload_json AS deposit_payload, f.payload_json AS refund_payload
      FROM library_unmatched_deposits u JOIN chain_events d ON d.event_id = u.deposit_event_id
      LEFT JOIN chain_events f ON f.event_id = u.refund_event_id
      WHERE (? IS NULL OR u.request_id = ?) AND (? IS NULL OR u.borrower = ?) ORDER BY u.request_id`)
      .all(requestId, requestId, borrower, borrower).map(row => ({
        requestId: String(row.request_id), borrower: String(row.borrower), latestEvent: String(row.latest_event_name),
        deposit: JSON.parse(String(row.deposit_payload)) as Extract<LibraryVerifiedChainEvent, { eventName: "DepositReceived" }>,
        refund: row.refund_payload === null ? null : JSON.parse(String(row.refund_payload)) as LibraryVerifiedChainEvent,
      }));
  }

  trackUnmatchedRefund(requestId: string, txHash: string, status: "SUBMITTED" | "CONFIRMED" | "REVERTED",
    blockNumber: number | null, blockHash: string | null) {
    this.db.prepare(`INSERT INTO library_unmatched_refund_attempts(tx_hash, request_id, status, block_number, block_hash)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(tx_hash) DO UPDATE SET status = excluded.status,
      block_number = excluded.block_number, block_hash = excluded.block_hash
      WHERE request_id = excluded.request_id AND library_unmatched_refund_attempts.status = 'SUBMITTED'`)
      .run(canonicalBytes32(txHash, "INVALID_LIBRARY_TX_HASH"), canonicalBytes32(requestId, "INVALID_LIBRARY_REQUEST_ID"), status, blockNumber, blockHash);
    const row = this.db.prepare("SELECT * FROM library_unmatched_refund_attempts WHERE tx_hash = ?").get(txHash.toLowerCase());
    if (!row || row.request_id !== requestId.toLowerCase()) throw new Error("LIBRARY_TRANSACTION_CONFLICT");
    return { txHash: String(row.tx_hash), status: String(row.status) as "SUBMITTED" | "CONFIRMED" | "REVERTED" };
  }

  recordHistoricalRevert(input: { requestId: string; action: LibraryStoredTransaction["action"]; txHash: string;
    submittedAt: number; blockNumber: number; blockHash: string; checkedAt: number }): LibraryStoredTransaction {
    const requestId = canonicalBytes32(input.requestId, "INVALID_LIBRARY_REQUEST_ID");
    const txHash = canonicalBytes32(input.txHash, "INVALID_LIBRARY_TX_HASH");
    const blockHash = canonicalBytes32(input.blockHash, "INVALID_LIBRARY_BLOCK_HASH");
    safeInteger(input.blockNumber, "INVALID_LIBRARY_BLOCK_NUMBER");
    safeInteger(input.submittedAt, "INVALID_LIBRARY_TIMESTAMP");
    beginImmediate(this.db);
    try {
      const existing = this.getTransaction(requestId, input.action);
      const attempt = this.getTransactionAttempt(requestId, input.action, txHash);
      if (attempt?.status === "CONFIRMED") throw new Error("LIBRARY_TRANSACTION_CONFLICT");
      if (attempt?.status === "REVERTED" && (attempt.blockNumber !== input.blockNumber || attempt.blockHash !== blockHash)) {
        throw new Error("LIBRARY_TRANSACTION_CONFLICT");
      }
      if (!existing) this.db.prepare(`INSERT INTO library_transactions
        (request_id, action, tx_hash, submitted_at, status, block_number, block_hash)
        VALUES (?, ?, ?, ?, 'REVERTED', ?, ?)`)
        .run(requestId, input.action, txHash, input.submittedAt, input.blockNumber, blockHash);
      else if (existing.txHash === txHash) this.db.prepare(`UPDATE library_transactions SET status = 'REVERTED', block_number = ?, block_hash = ?
        WHERE request_id = ? AND action = ? AND tx_hash = ? AND status <> 'CONFIRMED'`)
        .run(input.blockNumber, blockHash, requestId, input.action, txHash);
      this.db.prepare(`INSERT INTO library_transaction_attempts(tx_hash, request_id, action, submitted_at, status, block_number, block_hash)
        VALUES (?, ?, ?, ?, 'REVERTED', ?, ?) ON CONFLICT(tx_hash) DO UPDATE SET status = 'REVERTED',
        block_number = excluded.block_number, block_hash = excluded.block_hash
        WHERE request_id = excluded.request_id AND action = excluded.action AND status <> 'CONFIRMED'`)
        .run(txHash, requestId, input.action, input.submittedAt, input.blockNumber, blockHash);
      const result = this.getTransactionAttempt(requestId, input.action, txHash);
      if (!result || result.status !== "REVERTED") throw new Error("LIBRARY_TRANSACTION_CONFLICT");
      this.db.exec("COMMIT");
      return result;
    } catch (error) { rollback(this.db); throw error; }
  }

  listRequests(walletInput: string, queue = false): LibraryRequestRecord[] {
    const wallet = canonicalWallet(walletInput);
    const rows = queue
      ? this.db.prepare(`SELECT r.*, a.wallet FROM borrow_requests r JOIN accounts a USING(account_id)
        WHERE (r.status = 'PENDING_APPROVAL' AND r.copy_id IS NOT NULL)
          OR (r.status = 'REJECTED_NO_COPY' AND r.refund_status = 'REFUND_DUE' AND r.copy_id IS NULL) ORDER BY r.created_at, r.request_id`).all()
      : this.db.prepare(`SELECT r.*, a.wallet FROM borrow_requests r JOIN accounts a USING(account_id)
        WHERE a.wallet = ? COLLATE NOCASE ORDER BY r.created_at DESC, r.request_id`).all(wallet);
    return rows.map((row) => rowToRequest(row)!).filter(Boolean);
  }

  listLoans(walletInput?: string): Array<{ loanId: string; requestId: string; bookId: string; borrower: string; status: string;
    approvedAt: number; dueAt: number; returnRequestedAt: number | null; returnReceivedAt: number | null; settlement: unknown | null }> {
    const wallet = walletInput === undefined ? undefined : canonicalWallet(walletInput);
    const rows = wallet === undefined
      ? this.db.prepare(`SELECT l.*, a.wallet, s.outcome, s.retained_wei, s.refund_wei, s.shortfall_wei, e.payload_json AS event_json
        FROM loans l JOIN accounts a USING(account_id) LEFT JOIN settlements s USING(loan_id)
        LEFT JOIN chain_events e ON e.event_id = s.event_id ORDER BY l.approved_at DESC, l.loan_id`).all()
      : this.db.prepare(`SELECT l.*, a.wallet, s.outcome, s.retained_wei, s.refund_wei, s.shortfall_wei, e.payload_json AS event_json
        FROM loans l JOIN accounts a USING(account_id) LEFT JOIN settlements s USING(loan_id)
        LEFT JOIN chain_events e ON e.event_id = s.event_id WHERE a.wallet = ? COLLATE NOCASE
        ORDER BY l.approved_at DESC, l.loan_id`).all(wallet);
    return rows.map((row) => {
      let settlement: unknown | null = null;
      if (row.outcome === "RETURNED" && typeof row.event_json === "string") {
        const proof = JSON.parse(String(row.event_json)) as Record<string, unknown>;
        settlement = { outcome: "RETURNED", returnedAt: proof.returnedAt, lateFeeWei: proof.lateFeeWei,
          repairFeeWei: proof.repairFeeWei, overdueForfeitWei: proof.overdueForfeitWei, totalRetainedWei: proof.totalRetainedWei,
          refundWei: proof.refundWei, maintenanceRequired: proof.maintenanceRequired };
      } else if (row.outcome === "LOST" && typeof row.event_json === "string") {
        const proof = JSON.parse(String(row.event_json)) as Record<string, unknown>;
        settlement = { outcome: "LOST", replacementPriceWei: proof.replacementPriceWei, totalRetainedWei: proof.retainedWei,
          refundWei: proof.refundWei, shortfallWei: proof.shortfallWei };
      }
      return { loanId: String(row.loan_id), requestId: String(row.request_id), bookId: String(row.book_id), borrower: String(row.wallet),
        status: String(row.status), approvedAt: Number(row.approved_at), dueAt: Number(row.due_at),
        returnRequestedAt: row.return_requested_at === null ? null : Number(row.return_requested_at),
        returnReceivedAt: row.return_received_at === null ? null : Number(row.return_received_at), settlement };
    });
  }

  loanForSettlement(loanIdInput: string): { loanId: string; requestId: string; bookId: string; borrower: string;
    status: string; depositWei: string; replacementPriceWei: string; approvedAt: number; dueAt: number; returnReceivedAt: number | null } | undefined {
    const loanId = canonicalBytes32(loanIdInput, "INVALID_LIBRARY_LOAN_ID");
    const row = this.db.prepare(`SELECT l.*, a.wallet FROM loans l JOIN accounts a USING(account_id) WHERE l.loan_id = ?`).get(loanId);
    if (!row) return undefined;
    return { loanId, requestId: String(row.request_id), bookId: String(row.book_id), borrower: String(row.wallet),
      status: String(row.status), depositWei: String(row.deposit_wei), replacementPriceWei: String(row.replacement_price_wei),
      approvedAt: Number(row.approved_at), dueAt: Number(row.due_at),
      returnReceivedAt: row.return_received_at === null ? null : Number(row.return_received_at) };
  }

  createSettlementIntent(input: { intentId: string; loanId: string; librarianWallet: string; outcome: "RETURNED" | "LOST";
    condition?: "GOOD" | "DAMAGED"; reason: string; repairRequestedWei?: string; createdAt: number }): LibrarySettlementIntentRecord {
    if (!input.intentId.trim() || input.intentId.length > 200 || !input.reason.trim()) throw new Error("INVALID_LIBRARY_SETTLEMENT_INTENT");
    const loanId = canonicalBytes32(input.loanId, "INVALID_LIBRARY_LOAN_ID");
    const librarianWallet = canonicalWallet(input.librarianWallet);
    const createdAt = safeInteger(input.createdAt, "INVALID_LIBRARY_TIMESTAMP");
    if (input.outcome === "RETURNED" && (!input.condition || !["GOOD", "DAMAGED"].includes(input.condition))) {
      throw new Error("INVALID_LIBRARY_SETTLEMENT_INTENT");
    }
    if (input.outcome === "LOST" && (input.condition !== undefined || input.repairRequestedWei !== undefined)) {
      throw new Error("INVALID_LIBRARY_SETTLEMENT_INTENT");
    }
    const repair = input.repairRequestedWei === undefined ? null : canonicalWei(input.repairRequestedWei);
    beginImmediate(this.db);
    try {
      const actor = this.db.prepare("SELECT account_id, role FROM accounts WHERE wallet = ? COLLATE NOCASE AND enabled = 1")
        .get(librarianWallet);
      const loan = this.loanForSettlement(loanId);
      if (!actor || actor.role !== "LIBRARIAN") throw new Error("LIBRARY_ACCOUNT_NOT_ALLOWED");
      if (!loan) throw new Error("LIBRARY_REQUEST_NOT_FOUND");
      if (input.outcome === "RETURNED" ? loan.status !== "SETTLEMENT_PENDING" || loan.returnReceivedAt === null
        : !["ACTIVE", "RETURN_REQUESTED"].includes(loan.status)) throw new Error("LIBRARY_INVALID_LOAN_STATE");
      this.db.prepare(`INSERT INTO settlement_intents(intent_id, request_id, loan_id, librarian_account_id, outcome, condition,
        reason, repair_requested_wei, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.intentId, loan.requestId, loanId, Number(actor.account_id), input.outcome, input.condition ?? null,
          input.reason.trim(), repair, createdAt);
      this.db.prepare(`INSERT INTO audit_log(actor_account_id, actor_role, action, target_type, target_id, reason, created_at)
        VALUES (?, 'LIBRARIAN', 'settlement_intent_created', 'loan', ?, ?, ?)`)
        .run(Number(actor.account_id), loanId, input.reason.trim(), createdAt);
      const result = this.getSettlementIntent(input.intentId);
      if (!result) throw new Error("LIBRARY_SETTLEMENT_INTENT_WRITE_FAILED");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new Error("LIBRARY_SETTLEMENT_INTENT_CONFLICT");
      throw error;
    }
  }

  getSettlementIntent(intentId: string): LibrarySettlementIntentRecord | undefined {
    if (typeof intentId !== "string" || !intentId.trim() || intentId.length > 200) return undefined;
    const row = this.db.prepare(`SELECT i.intent_id, i.request_id, i.loan_id, i.outcome, i.condition, i.reason,
      i.repair_requested_wei, i.created_at, a.wallet FROM settlement_intents i
      JOIN accounts a ON a.account_id = i.librarian_account_id WHERE i.intent_id = ?`).get(intentId);
    if (!row) return undefined;
    return { intentId: String(row.intent_id), requestId: String(row.request_id), loanId: String(row.loan_id),
      librarianWallet: String(row.wallet), outcome: String(row.outcome) as "RETURNED" | "LOST",
      condition: row.condition === null ? null : String(row.condition) as "GOOD" | "DAMAGED", reason: String(row.reason),
      repairRequestedWei: row.repair_requested_wei === null ? null : String(row.repair_requested_wei), createdAt: Number(row.created_at) };
  }

  requestReturn(input: { loanId: string; wallet: string; requestedAt: number }): { loanId: string; requestId: string; status: string; requestedAt: number } {
    const loanId = canonicalBytes32(input.loanId, "INVALID_LIBRARY_LOAN_ID");
    const wallet = canonicalWallet(input.wallet);
    safeInteger(input.requestedAt, "INVALID_LIBRARY_TIMESTAMP");
    beginImmediate(this.db);
    try {
      const loan = this.db.prepare(`SELECT l.request_id, l.status, l.return_requested_at, a.wallet, a.account_id
        FROM loans l JOIN accounts a USING(account_id) WHERE l.loan_id = ?`).get(loanId);
      if (!loan || String(loan.wallet).toLowerCase() !== wallet) throw new Error("LIBRARY_REQUEST_NOT_FOUND");
      if (loan.return_requested_at !== null) {
        this.db.exec("COMMIT");
        return { loanId, requestId: String(loan.request_id), status: "RETURN_REQUESTED", requestedAt: Number(loan.return_requested_at) };
      }
      if (loan.status !== "ACTIVE") throw new Error("LIBRARY_INVALID_LOAN_STATE");
      this.db.prepare("UPDATE loans SET status = 'RETURN_REQUESTED', return_requested_at = ?, updated_at = ? WHERE loan_id = ? AND status = 'ACTIVE'")
        .run(input.requestedAt, input.requestedAt, loanId);
      this.db.prepare("UPDATE borrow_requests SET status = 'RETURN_REQUESTED', updated_at = ? WHERE request_id = ?")
        .run(input.requestedAt, String(loan.request_id));
      this.db.prepare(`INSERT INTO audit_log(actor_account_id, actor_role, action, target_type, target_id, created_at)
        VALUES (?, 'STUDENT', 'return_requested', 'loan', ?, ?)`)
        .run(Number(loan.account_id), loanId, input.requestedAt);
      this.db.exec("COMMIT");
      return { loanId, requestId: String(loan.request_id), status: "RETURN_REQUESTED", requestedAt: input.requestedAt };
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
  }

  expirePendingRequests(chainTime: number): number {
    safeInteger(chainTime, "INVALID_LIBRARY_TIMESTAMP");
    beginImmediate(this.db);
    try {
      const expired = this.db.prepare(`SELECT request_id, copy_id FROM borrow_requests
        WHERE status = 'PENDING_APPROVAL' AND approval_deadline <= ? ORDER BY approval_deadline, request_id`).all(chainTime);
      for (const request of expired) {
        if (typeof request.copy_id === "string") {
          const released = this.db.prepare("UPDATE book_copies SET status = 'AVAILABLE' WHERE copy_id = ? AND status = 'PENDING_APPROVAL'")
            .run(request.copy_id);
          if (released.changes !== 1) throw new Error("LIBRARY_EVENT_COPY_CONFLICT");
        }
        this.db.prepare(`UPDATE borrow_requests SET copy_id = NULL, status = 'EXPIRED_REFUND_DUE', refund_status = 'REFUND_DUE',
          updated_at = ? WHERE request_id = ? AND status = 'PENDING_APPROVAL'`).run(chainTime, request.request_id);
      }
      this.db.exec("COMMIT");
      return expired.length;
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
  }

  accountStatus(walletInput: string, chainTime: number, holdAfterSeconds: number): { held: boolean; checkedAt: number; blockingLoanIds: string[] } {
    const wallet = canonicalWallet(walletInput);
    safeInteger(chainTime, "INVALID_LIBRARY_TIMESTAMP");
    safeInteger(holdAfterSeconds, "INVALID_LIBRARY_HOLD_POLICY", 1);
    beginImmediate(this.db);
    try {
      const account = this.db.prepare("SELECT account_id FROM accounts WHERE wallet = ? COLLATE NOCASE AND enabled = 1").get(wallet);
      if (!account) throw new Error("LIBRARY_ACCOUNT_NOT_ALLOWED");
      this.db.prepare(`INSERT INTO account_holds(account_id, loan_id, hold_type, started_at)
        SELECT l.account_id, l.loan_id, 'OVERDUE', ? FROM loans l
        WHERE l.account_id = ? AND l.status IN ('ACTIVE', 'RETURN_REQUESTED', 'SETTLEMENT_PENDING') AND ? > l.due_at + ?
        ON CONFLICT(account_id, loan_id, hold_type) DO NOTHING`).run(chainTime, Number(account.account_id), chainTime, holdAfterSeconds);
      this.db.prepare(`INSERT INTO account_holds(account_id, loan_id, hold_type, started_at)
        SELECT l.account_id, l.loan_id, 'LOST_SHORTFALL', ? FROM loans l
        WHERE l.account_id = ? AND l.status = 'LOST_SHORTFALL_DUE'
        ON CONFLICT(account_id, loan_id, hold_type) DO NOTHING`).run(chainTime, Number(account.account_id));
      this.db.prepare(`UPDATE account_holds SET released_at = ? WHERE account_id = ? AND released_at IS NULL AND (
        (hold_type = 'OVERDUE' AND (SELECT status FROM loans WHERE loan_id = account_holds.loan_id) NOT IN ('ACTIVE', 'RETURN_REQUESTED', 'SETTLEMENT_PENDING'))
        OR (hold_type = 'LOST_SHORTFALL' AND (SELECT status FROM loans WHERE loan_id = account_holds.loan_id) <> 'LOST_SHORTFALL_DUE'))`)
        .run(chainTime, Number(account.account_id));
      const rows = this.db.prepare(`SELECT DISTINCT h.loan_id FROM account_holds h
        JOIN loans l USING(loan_id) WHERE h.account_id = ? AND h.released_at IS NULL
        AND ((h.hold_type = 'OVERDUE' AND ? > l.due_at + ?) OR h.hold_type = 'LOST_SHORTFALL')
        ORDER BY h.loan_id`).all(Number(account.account_id), chainTime, holdAfterSeconds);
      this.db.exec("COMMIT");
      const blockingLoanIds = rows.map((row) => String(row.loan_id));
      return { held: blockingLoanIds.length > 0, checkedAt: chainTime, blockingLoanIds };
    } catch (error) {
      rollback(this.db);
      if (librarySqliteBusy(error)) throw new Error("LIBRARY_DATABASE_BUSY");
      throw error;
    }
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
    beginImmediate(this.db);
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
      rollback(this.db);
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
    beginImmediate(this.db);
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
      rollback(this.db);
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
    beginImmediate(this.db);
    try {
      const changed = this.db.prepare("UPDATE accounts SET enabled = ? WHERE wallet = ? COLLATE NOCASE").run(enabled ? 1 : 0, wallet);
      if (changed.changes !== 1) throw new Error("LIBRARY_ACCOUNT_NOT_FOUND");
      if (!enabled) this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE account_id = (SELECT account_id FROM accounts WHERE wallet = ? COLLATE NOCASE) AND revoked_at IS NULL")
        .run(changedAt, wallet);
      this.db.exec("COMMIT");
    } catch (error) {
      rollback(this.db);
      throw error;
    }
  }
}

export type { LibraryAccountSeed, LibraryBookRecord, LibraryDbRefundStatus, LibraryDbRequestStatus, LibraryDemoSeed,
  LibraryChallengeRecord, LibraryDepositProjection, LibraryRequestRecord, LibrarySettlementIntentRecord, LibrarySessionRecord,
  LibraryStoredTransaction, LibraryVerifiedChainEvent, LibraryVerifiedDeposit } from "./library.types.ts";
