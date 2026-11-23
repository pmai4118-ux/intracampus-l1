import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdminAuditEntry } from "@intracampus/network";

export type AdminRuntimeConfigKey =
  | "parking_merchant_address"
  | "canteen_merchant_address"
  | "welcome_treasury_address"
  | "scholarship_wei";

export type AdminSessionRecord = {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
};

export type NativeMintOperation = {
  requestId: string;
  target: string;
  amountWei: string;
  txHash: string | null;
  status: "READY" | "IN_PROGRESS" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export class AdminRepository {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      ${path === ":memory:" ? "" : "PRAGMA journal_mode = WAL;"}
      PRAGMA synchronous = FULL;

      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS admin_login_limits (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS admin_runtime_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        summary TEXT NOT NULL,
        tx_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('DONE', 'SUBMITTED', 'CONFIRMED', 'FAILED')),
        error_code TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ix_admin_audit_created ON admin_audit_log(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS ix_admin_audit_tx_hash ON admin_audit_log(tx_hash) WHERE tx_hash IS NOT NULL;

      CREATE TABLE IF NOT EXISTS admin_native_mint_operations (
        request_id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        amount_wei TEXT NOT NULL,
        tx_hash TEXT UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('READY', 'IN_PROGRESS', 'SUBMITTED', 'CONFIRMED', 'FAILED')),
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private atomic<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve error */ }
      throw error;
    }
  }

  consumeLoginRateLimit(bucket: string, now: number, maxRequests: number, windowSeconds: number): {
    allowed: boolean;
    retryAfterSeconds: number;
  } {
    return this.atomic(() => {
      const window = Math.floor(now / windowSeconds);
      const key = `${bucket}:${window}`;
      const expiresAt = (window + 1) * windowSeconds;
      this.db.prepare("DELETE FROM admin_login_limits WHERE expires_at <= ?").run(now);
      this.db.prepare(
        "INSERT INTO admin_login_limits(bucket, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1",
      ).run(key, expiresAt);
      const row = this.db.prepare("SELECT count FROM admin_login_limits WHERE bucket = ?").get(key);
      const count = Number(row?.count ?? 0);
      return { allowed: count <= maxRequests, retryAfterSeconds: Math.max(1, expiresAt - now) };
    });
  }

  createSession(tokenHash: string, now: number, expiresAt: number): AdminSessionRecord {
    return this.atomic(() => {
      this.db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now);
      this.db.prepare("INSERT INTO admin_sessions(token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(tokenHash, now, expiresAt);
      return { tokenHash, createdAt: now, expiresAt };
    });
  }

  getSession(tokenHash: string, now: number): AdminSessionRecord | undefined {
    const row = this.db.prepare("SELECT token_hash, created_at, expires_at FROM admin_sessions WHERE token_hash = ?").get(tokenHash);
    if (!row) return undefined;
    const expiresAt = Number(row.expires_at);
    if (expiresAt <= now) {
      this.db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash);
      return undefined;
    }
    return { tokenHash: String(row.token_hash), createdAt: Number(row.created_at), expiresAt };
  }

  revokeSession(tokenHash: string): boolean {
    return this.db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(tokenHash).changes > 0;
  }

  getRuntimeValue(key: AdminRuntimeConfigKey): string | undefined {
    const row = this.db.prepare("SELECT value FROM admin_runtime_config WHERE key = ?").get(key);
    return row ? String(row.value) : undefined;
  }

  setRuntimeValue(key: AdminRuntimeConfigKey, value: string, now = Math.floor(Date.now() / 1000)): void {
    this.db.prepare(
      "INSERT INTO admin_runtime_config(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(key, value, now);
  }

  deleteRuntimeValue(key: AdminRuntimeConfigKey): void {
    this.db.prepare("DELETE FROM admin_runtime_config WHERE key = ?").run(key);
  }

  getRuntimeSnapshot(): { values: Partial<Record<AdminRuntimeConfigKey, string>>; updatedAt: number } {
    const rows = this.db.prepare("SELECT key, value, updated_at FROM admin_runtime_config").all();
    const values: Partial<Record<AdminRuntimeConfigKey, string>> = {};
    let updatedAt = 0;
    for (const row of rows) {
      values[String(row.key) as AdminRuntimeConfigKey] = String(row.value);
      updatedAt = Math.max(updatedAt, Number(row.updated_at));
    }
    return { values, updatedAt };
  }

  recordAudit(entry: {
    action: string;
    target: string;
    summary: string;
    txHash?: string | null;
    status: AdminAuditEntry["status"];
    errorCode?: string | null;
    createdAt?: number;
  }): AdminAuditEntry {
    const createdAt = entry.createdAt ?? Math.floor(Date.now() / 1000);
    const txHash = entry.txHash ? entry.txHash.toLowerCase() : null;
    const errorCode = entry.errorCode ?? null;
    const result = this.db.prepare(
      "INSERT INTO admin_audit_log(action, target, summary, tx_hash, status, error_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(entry.action, entry.target, entry.summary, txHash, entry.status, errorCode, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      action: entry.action,
      target: entry.target,
      summary: entry.summary,
      txHash,
      status: entry.status,
      errorCode,
      createdAt,
    };
  }

  updateAuditByTxHash(txHash: string, status: "CONFIRMED" | "FAILED", errorCode: string | null = null): void {
    this.db.prepare("UPDATE admin_audit_log SET status = ?, error_code = ? WHERE tx_hash = ? COLLATE NOCASE")
      .run(status, errorCode, txHash.toLowerCase());
  }

  getAuditByTxHash(txHash: string): AdminAuditEntry | undefined {
    const row = this.db.prepare(
      "SELECT id, action, target, summary, tx_hash, status, error_code, created_at FROM admin_audit_log WHERE tx_hash = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1",
    ).get(txHash.toLowerCase());
    if (!row) return undefined;
    return {
      id: Number(row.id), action: String(row.action), target: String(row.target), summary: String(row.summary),
      txHash: row.tx_hash === null ? null : String(row.tx_hash), status: String(row.status) as AdminAuditEntry["status"],
      errorCode: row.error_code === null ? null : String(row.error_code), createdAt: Number(row.created_at),
    };
  }

  getNativeMintOperation(requestId: string): NativeMintOperation | undefined {
    const row = this.db.prepare(
      "SELECT request_id, target, amount_wei, tx_hash, status, error_code, created_at, updated_at FROM admin_native_mint_operations WHERE request_id = ?",
    ).get(requestId);
    return row ? {
      requestId: String(row.request_id), target: String(row.target), amountWei: String(row.amount_wei),
      txHash: row.tx_hash === null ? null : String(row.tx_hash), status: String(row.status) as NativeMintOperation["status"],
      errorCode: row.error_code === null ? null : String(row.error_code), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    } : undefined;
  }

  getNativeMintOperationByHash(txHash: string): NativeMintOperation | undefined {
    const row = this.db.prepare(
      "SELECT request_id, target, amount_wei, tx_hash, status, error_code, created_at, updated_at FROM admin_native_mint_operations WHERE tx_hash = ? COLLATE NOCASE",
    ).get(txHash.toLowerCase());
    return row ? {
      requestId: String(row.request_id), target: String(row.target), amountWei: String(row.amount_wei),
      txHash: row.tx_hash === null ? null : String(row.tx_hash), status: String(row.status) as NativeMintOperation["status"],
      errorCode: row.error_code === null ? null : String(row.error_code), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    } : undefined;
  }

  prepareNativeMintOperation(input: { requestId: string; target: string; amountWei: string; now: number }): NativeMintOperation {
    return this.atomic(() => {
      const existing = this.getNativeMintOperation(input.requestId);
      if (existing) {
        if (existing.target.toLowerCase() !== input.target.toLowerCase() || existing.amountWei !== input.amountWei) throw Error("IDEMPOTENCY_KEY_CONFLICT");
        return existing;
      }
      this.db.prepare(`INSERT INTO admin_native_mint_operations
        (request_id,target,amount_wei,tx_hash,status,error_code,created_at,updated_at) VALUES (?,?,?,NULL,'READY',NULL,?,?)`)
        .run(input.requestId, input.target.toLowerCase(), input.amountWei, input.now, input.now);
      return this.getNativeMintOperation(input.requestId)!;
    });
  }

  claimNativeMintOperation(requestId: string, now: number, staleAfterSeconds = 120): boolean {
    const result = this.db.prepare(`UPDATE admin_native_mint_operations SET status='IN_PROGRESS',error_code=NULL,updated_at=?
      WHERE request_id=? AND tx_hash IS NULL AND (status='READY' OR (status='IN_PROGRESS' AND updated_at<=?))`)
      .run(now, requestId, now - staleAfterSeconds);
    return result.changes > 0;
  }

  attachNativeMintHash(requestId: string, txHash: string, now: number): void {
    this.atomic(() => {
      const op = this.getNativeMintOperation(requestId);
      if (!op) throw Error("NATIVE_MINT_OPERATION_NOT_FOUND");
      if (op.txHash) {
        if (op.txHash.toLowerCase() !== txHash.toLowerCase()) throw Error("NATIVE_MINT_HASH_CONFLICT");
        return;
      }
      if (op.status !== "IN_PROGRESS") throw Error("NATIVE_MINT_OPERATION_LOCKED");
      this.db.prepare("UPDATE admin_native_mint_operations SET tx_hash=?,status='SUBMITTED',error_code=NULL,updated_at=? WHERE request_id=?")
        .run(txHash.toLowerCase(), now, requestId);
      this.db.prepare(`INSERT INTO admin_audit_log(action,target,summary,tx_hash,status,error_code,created_at)
        VALUES ('MINT_NATIVE_CAMPUS',?,?,?,'SUBMITTED',NULL,?)`)
        .run(op.target, `Mint ${op.amountWei} wei CAMPUS tới ${op.target} bằng Native Minter`, txHash.toLowerCase(), now);
    });
  }

  releaseNativeMintOperation(requestId: string, errorCode: string, now: number): void {
    this.db.prepare(`UPDATE admin_native_mint_operations SET status='READY',error_code=?,updated_at=?
      WHERE request_id=? AND tx_hash IS NULL AND status='IN_PROGRESS'`)
      .run(errorCode, now, requestId);
  }

  finishNativeMintOperation(txHash: string, status: "CONFIRMED" | "FAILED", errorCode: string | null, now: number): void {
    this.atomic(() => {
      this.db.prepare(`UPDATE admin_native_mint_operations SET status=?,error_code=?,updated_at=? WHERE tx_hash=? COLLATE NOCASE`)
        .run(status, errorCode, now, txHash.toLowerCase());
      this.updateAuditByTxHash(txHash, status, errorCode);
    });
  }

  listAudit(limit = 50): AdminAuditEntry[] {
    const safeLimit = Math.min(200, Math.max(1, limit));
    return this.db.prepare(
      "SELECT id, action, target, summary, tx_hash, status, error_code, created_at FROM admin_audit_log ORDER BY id DESC LIMIT ?",
    ).all(safeLimit).map((row) => ({
      id: Number(row.id),
      action: String(row.action),
      target: String(row.target),
      summary: String(row.summary),
      txHash: row.tx_hash === null ? null : String(row.tx_hash),
      status: String(row.status) as AdminAuditEntry["status"],
      errorCode: row.error_code === null ? null : String(row.error_code),
      createdAt: Number(row.created_at),
    }));
  }
}
