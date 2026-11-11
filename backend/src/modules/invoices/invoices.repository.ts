import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InvoiceTransaction, SignedInvoiceEnvelope, VerifiedInvoiceReceipt } from "@intracampus/network";
import { assertEnvelope } from "./invoices.schema.ts";

export type InvoiceRecord = {
  envelope: SignedInvoiceEnvelope;
  lastKnownStatus: "pending" | "expired" | null;
  updatedAt: number | null;
  transaction: InvoiceTransaction | null;
  receipt: VerifiedInvoiceReceipt | null;
  nextScanBlock: number | null;
};
export interface InvoiceRepository {
  create(envelope: SignedInvoiceEnvelope): void;
  get(invoiceId: string): InvoiceRecord | undefined;
  save(invoiceId: string, record: InvoiceRecord): InvoiceRecord;
  confirm(invoiceId: string, record: InvoiceRecord & { receipt: VerifiedInvoiceReceipt }): { record: InvoiceRecord; changed: boolean };
}

export class SqliteInvoiceRepository implements InvoiceRepository {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS invoices (
        invoice_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, event_key TEXT UNIQUE
      ) STRICT;`);
  }
  close(): void { this.db.close(); }
  create(envelope: SignedInvoiceEnvelope): void {
    assertEnvelope(envelope);
    const record: InvoiceRecord = { envelope, lastKnownStatus: null, updatedAt: null, transaction: null, receipt: null, nextScanBlock: null };
    // Duplicate IDs fail rather than replacing an invoice or an already verified receipt.
    this.db.prepare("INSERT INTO invoices(invoice_id, record_json) VALUES (?, ?)")
      .run(envelope.invoice.invoiceId.toLowerCase(), JSON.stringify(record));
  }
  get(invoiceId: string): InvoiceRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM invoices WHERE invoice_id = ?").get(invoiceId.toLowerCase());
    return row ? JSON.parse(row.record_json as string) as InvoiceRecord : undefined;
  }
  save(invoiceId: string, record: InvoiceRecord): InvoiceRecord {
    if (record.receipt) throw new Error("Use confirm to store a receipt");
    this.db.prepare("UPDATE invoices SET record_json = ? WHERE invoice_id = ? AND event_key IS NULL")
      .run(JSON.stringify(record), invoiceId.toLowerCase());
    return this.require(invoiceId);
  }
  confirm(invoiceId: string, record: InvoiceRecord & { receipt: VerifiedInvoiceReceipt }): { record: InvoiceRecord; changed: boolean } {
    const r = record.receipt;
    const key = `${r.chainId}:${r.contractAddress.toLowerCase()}:${r.txHash.toLowerCase()}:${r.logIndex}`;
    const result = this.db.prepare("UPDATE invoices SET record_json = ?, event_key = ? WHERE invoice_id = ? AND event_key IS NULL")
      .run(JSON.stringify(record), key, invoiceId.toLowerCase());
    return { record: this.require(invoiceId), changed: result.changes === 1 };
  }
  private require(id: string): InvoiceRecord {
    const record = this.get(id);
    if (!record) throw new Error("Invoice no longer exists");
    return record;
  }
}
