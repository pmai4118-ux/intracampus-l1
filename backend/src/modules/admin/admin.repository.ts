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
