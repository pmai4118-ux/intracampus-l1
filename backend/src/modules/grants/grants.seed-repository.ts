import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type GrantSeedIntent = { transactionHash: string; nonce: number };

/** Public intent only. A durable unique claim must exist before any broadcast. */
export class GrantSeedJournal {
  private db: DatabaseSync;
  constructor(path: string, { readOnly = false } = {}) {
    if (!readOnly && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly, timeout: 5000 });
    if (!readOnly) this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS grant_seed_intents (
        operation_id TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL, nonce INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS grant_seed_retired (
        operation_id TEXT NOT NULL, transaction_hash TEXT NOT NULL, nonce INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('not-broadcast', 'canonical-revert')),
        PRIMARY KEY(operation_id, transaction_hash)
      ) STRICT;`);
  }
  get(operationId: string): GrantSeedIntent | undefined {
    const row = this.db.prepare("SELECT transaction_hash, nonce FROM grant_seed_intents WHERE operation_id = ?").get(operationId);
    if (!row) return undefined;
    if (typeof row.transaction_hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.transaction_hash)
      || typeof row.nonce !== "number" || !Number.isSafeInteger(row.nonce) || row.nonce < 0) throw new Error("INVALID_SEED_JOURNAL");
    return { transactionHash: row.transaction_hash, nonce: row.nonce };
  }
  reserve(operationId: string, intent: GrantSeedIntent): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO grant_seed_intents(operation_id, transaction_hash, nonce) VALUES (?, ?, ?)")
      .run(operationId, intent.transactionHash, intent.nonce).changes === 1;
  }
  retire(operationId: string, transactionHash: string, reason: "not-broadcast" | "canonical-revert"): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT OR IGNORE INTO grant_seed_retired
        SELECT operation_id, transaction_hash, nonce, ? FROM grant_seed_intents
        WHERE operation_id = ? AND transaction_hash = ?`).run(reason, operationId, transactionHash);
      this.db.prepare("DELETE FROM grant_seed_intents WHERE operation_id = ? AND transaction_hash = ?").run(operationId, transactionHash);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
