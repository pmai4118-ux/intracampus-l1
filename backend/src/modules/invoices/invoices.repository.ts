import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isParkingInvoice, type InvoiceTransaction, type OpenParkingTicket, type SignedInvoiceEnvelope, type VerifiedInvoiceReceipt } from "@intracampus/network";
import { assertEnvelope, object, same } from "./invoices.schema.ts";

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

function readInvoiceRecord(invoiceId: string, recordJson: string): InvoiceRecord {
  const parsed = object(JSON.parse(recordJson));
  const envelope = parsed.envelope;
  // Revalidate persisted data so older rows cannot expose unexpected envelope fields.
  assertEnvelope(envelope);
  if (!same(envelope.invoice.invoiceId, invoiceId)) throw new Error("Invoice record ID mismatch");
  return { ...parsed, envelope } as unknown as InvoiceRecord;
}

export class SqliteInvoiceRepository implements InvoiceRepository {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS invoices (
        invoice_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, event_key TEXT UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS parking_checkouts (
        invoice_id TEXT PRIMARY KEY REFERENCES invoices(invoice_id),
        checked_out_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS invoices_payer_idx
        ON invoices (lower(json_extract(record_json, '$.receipt.payer')))
        WHERE event_key IS NOT NULL;`);
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
    return row ? readInvoiceRecord(invoiceId, row.record_json as string) : undefined;
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
  openParkingTickets(payer: string): OpenParkingTicket[] {
    const rows = this.db.prepare(`
      SELECT invoice_id, record_json FROM invoices
      WHERE event_key IS NOT NULL AND lower(json_extract(record_json, '$.receipt.payer')) = ?
        AND NOT EXISTS (SELECT 1 FROM parking_checkouts WHERE parking_checkouts.invoice_id = invoices.invoice_id)
      ORDER BY json_extract(record_json, '$.receipt.verifiedAt') DESC, invoice_id
    `).all(payer.toLowerCase());
    return rows.flatMap((row) => {
      const invoiceId = row.invoice_id as string;
      const { envelope, receipt } = readInvoiceRecord(invoiceId, row.record_json as string);
      if (!isParkingInvoice(envelope) || !receipt) return [];
      return [{ invoiceId, invoiceCode: envelope.meta.invoiceCode, checkedInAt: receipt.verifiedAt }];
    });
  }
  parkingCheckoutAt(invoiceId: string): number | null {
    const row = this.db.prepare("SELECT checked_out_at FROM parking_checkouts WHERE invoice_id = ?")
      .get(invoiceId.toLowerCase());
    return row ? Number(row.checked_out_at) : null;
  }
  recordParkingCheckout(invoiceId: string, checkedOutAt: number): number {
    this.db.prepare("INSERT INTO parking_checkouts VALUES (?, ?) ON CONFLICT(invoice_id) DO NOTHING")
      .run(invoiceId.toLowerCase(), checkedOutAt);
    return this.parkingCheckoutAt(invoiceId)!;
  }
  private require(id: string): InvoiceRecord {
    const record = this.get(id);
    if (!record) throw new Error("Invoice no longer exists");
    return record;
  }
}
