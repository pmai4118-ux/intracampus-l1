import { campusNetwork, type InvoiceLookupResponse, type SignedInvoiceEnvelope, type VerifiedInvoiceReceipt } from "@intracampus/network";
import { isWalletAddress } from "./chains.ts";
import { parseInvoicePayload, sameInvoiceEnvelope } from "./invoice.ts";

export const POS_ACTIVE_INVOICE_KEY = "intracampus.pos.invoiceId.v1";
export const isInvoiceHash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const money = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= (BigInt(1) << BigInt(256)) - BigInt(1);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Backend trả dữ liệu tra cứu chưa đúng định dạng.");
  return value as Record<string, unknown>;
}
function check(condition: unknown): asserts condition { if (!condition) throw Error("Biên nhận chưa khớp hóa đơn; chưa xác nhận thanh toán."); }

/** Structural defense on a trusted same-origin API; chain/event verification stays in B02. */
export function parseInvoiceLookup(value: unknown, invoiceId: string, expected?: SignedInvoiceEnvelope): InvoiceLookupResponse {
  const data = object(value);
  const envelope = parseInvoicePayload(JSON.stringify(data.envelope));
  check(same(data.invoiceId, invoiceId) && same(envelope.invoice.invoiceId, invoiceId));
  if (expected) check(sameInvoiceEnvelope(expected, envelope));
  check(["pending", "paid", "expired", "rpc-error"].includes(String(data.status)));
  check(integer(data.updatedAt) || (data.status === "rpc-error" && data.updatedAt === null));
  if (data.error !== undefined) {
    const error = object(data.error);
    check(["INVALID_REQUEST", "INVOICE_NOT_FOUND", "RPC_UNAVAILABLE", "WRONG_CHAIN", "TX_REVERTED", "RECEIPT_EVENT_MISMATCH", "INTERNAL_ERROR"].includes(String(error.code))
      && typeof error.retryable === "boolean" && typeof error.message === "string" && typeof error.nextStep === "string");
  }
  if (data.transaction !== null) {
    const transaction = object(data.transaction);
    check(isInvoiceHash(transaction.txHash) && ["unverified", "reverted", "event-mismatch", "confirmed"].includes(String(transaction.status)));
  }
  if (data.status === "paid") {
    const r = object(data.receipt), tx = object(data.transaction);
    check(tx.status === "confirmed" && isInvoiceHash(r.txHash) && same(r.txHash, String(tx.txHash))
      && same(r.invoiceId, invoiceId) && r.invoiceCode === envelope.meta.invoiceCode
      && r.chainId === campusNetwork.chainId && same(r.contractAddress, envelope.domain.verifyingContract)
      && same(r.merchant, envelope.invoice.merchant) && same(r.category, envelope.invoice.category)
      && isWalletAddress(r.payer) && integer(r.blockNumber) && integer(r.logIndex) && integer(r.verifiedAt)
      && r.verifiedAt === data.updatedAt && (r.tier === 0 || r.tier === 1)
      && money(r.originalAmount) && money(r.discountAmount) && money(r.paidAmount)
      && money(r.gasUsed) && money(r.effectiveGasPrice));
    const original = BigInt(envelope.invoice.amount), discount = r.tier === 1 ? original / BigInt(10) : BigInt(0);
    check(BigInt(String(r.originalAmount)) === original && BigInt(String(r.discountAmount)) === discount
      && BigInt(String(r.paidAmount)) === original - discount);
  } else {
    check(data.receipt === null && (data.transaction === null || object(data.transaction).status !== "confirmed"));
    if (data.status === "rpc-error") check(data.error && [null, "pending", "expired"].includes(data.lastKnownStatus as null | string));
  }
  return { ...data, envelope } as unknown as InvoiceLookupResponse;
}
export function receiptEventKey(receipt: VerifiedInvoiceReceipt): string {
  return `${receipt.chainId}:${receipt.contractAddress.toLowerCase()}:${receipt.txHash.toLowerCase()}:${receipt.logIndex}`;
}
export type InvoiceStatusSnapshot = {
  invoiceId: string | null; envelope: SignedInvoiceEnvelope | null; lookup: InvoiceLookupResponse | null;
  pendingHash: string | null;
  busy: boolean; message: string | null; storageWarning: string | null; announcement: string | null;
};
type Options = { fetcher?: typeof fetch; storage?: Pick<Storage, "getItem" | "setItem">;
  schedule?: (callback: () => void, delay: number) => unknown; cancel?: (handle: unknown) => void };

export class InvoiceStatusController {
  private state: InvoiceStatusSnapshot = { invoiceId: null, envelope: null, lookup: null, pendingHash: null, busy: false,
    message: null, storageWarning: null, announcement: null };
  private listeners = new Set<() => void>();
  private fetcher: typeof fetch;
  private storage?: Options["storage"];
  private schedule: NonNullable<Options["schedule"]>;
  private cancel: NonNullable<Options["cancel"]>;
  private timer: unknown;
  private request?: AbortController;
  private generation = 0;
  private disposed = false;
  private failures = 0;
  private hint?: string;
  private announced = new Set<string>();
  constructor(options: Options = {}) {
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.storage = options.storage;
    this.schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<InvoiceStatusSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  private stored(key: string, value?: string): string | null {
    try {
      if (!this.storage) throw Error();
      if (value !== undefined) { this.storage.setItem(key, value); return value; }
      return this.storage.getItem(key);
    } catch { this.update({ storageWarning: "Trình duyệt không lưu được phiên POS. Giữ mã invoiceId để mở lại hóa đơn sau khi tải lại." }); return null; }
  }
  async restore() {
    const id = this.stored(POS_ACTIVE_INVOICE_KEY);
    if (id && isInvoiceHash(id)) await this.watch(id);
    else if (id) this.update({ message: "Mã hóa đơn đã lưu không hợp lệ. Nhập invoiceId để tra cứu lại." });
  }
  async watch(invoiceId: string, envelope?: SignedInvoiceEnvelope, txHash?: string) {
    if (this.disposed) return;
    if (!isInvoiceHash(invoiceId) || (txHash !== undefined && !isInvoiceHash(txHash))) throw Error("invoiceId và tx hash phải là mã hex 32 byte.");
    if (envelope) check(same(envelope.invoice.invoiceId, invoiceId));
    this.generation++; this.request?.abort(); this.clearTimer(); this.failures = 0;
    const oldHint = this.stored(`intracampus.pos.hash.${invoiceId.toLowerCase()}`);
    this.hint = isInvoiceHash(oldHint) ? oldHint : txHash;
    this.update({ invoiceId: invoiceId.toLowerCase(), envelope: envelope ?? null, lookup: null, pendingHash: this.hint ?? null, busy: false, message: null, announcement: null });
    if (this.hint) this.stored(`intracampus.pos.hash.${invoiceId.toLowerCase()}`, this.hint);
    this.stored(POS_ACTIVE_INVOICE_KEY, invoiceId.toLowerCase());
    await this.read();
  }
  async refresh(txHash?: string) {
    if (this.disposed) return;
    if (txHash !== undefined) {
      if (!isInvoiceHash(txHash)) throw Error("Tx hash phải là mã hex 32 byte.");
      const transaction = this.state.lookup?.transaction;
      this.hint = transaction?.status === "unverified" ? transaction.txHash : this.state.pendingHash ?? txHash;
      if (this.state.invoiceId) this.stored(`intracampus.pos.hash.${this.state.invoiceId}`, this.hint);
      this.update({ pendingHash: this.hint });
    }
    if (!this.state.busy) { this.clearTimer(); await this.read(); }
  }
  private clearTimer() { if (this.timer !== undefined) this.cancel(this.timer); this.timer = undefined; }
  private retry(delay: number) {
    this.clearTimer();
    this.timer = this.schedule(() => { this.timer = undefined; void this.read(); }, delay);
  }
  private async read() {
    if (this.disposed || !this.state.invoiceId || this.state.busy) return;
    const generation = this.generation, id = this.state.invoiceId, sentHint = this.hint;
    const request = new AbortController(); this.request = request;
    this.update({ busy: true, message: null });
    let nextDelay: number | undefined;
    try {
      const response = await this.fetcher(`/api/invoices/${encodeURIComponent(id)}${this.hint ? `?txHash=${encodeURIComponent(this.hint)}` : ""}`,
        { cache: "no-store", headers: { accept: "application/json" }, signal: request.signal });
      if (this.disposed || generation !== this.generation) return;
      if (response.status === 400 || response.status === 404) {
        this.update({ message: response.status === 404 ? "Không tìm thấy hóa đơn. Kiểm tra invoiceId hoặc kho dữ liệu của backend." : "Yêu cầu tra cứu hóa đơn không hợp lệ." });
        return;
      }
      if (![200, 422, 503].includes(response.status)) throw Error("Tạm thời không đọc được API hóa đơn. Giữ invoiceId và hash cũ; chưa gửi lại thanh toán.");
      const lookup = parseInvoiceLookup(await response.json(), id, this.state.envelope ?? undefined);
      if (this.disposed || generation !== this.generation) return;
      check((response.status === 503) === (lookup.status === "rpc-error"));
      check(response.status !== 422 || (lookup.status !== "paid" && "error" in lookup && lookup.error
        && ["TX_REVERTED", "RECEIPT_EVENT_MISMATCH"].includes(lookup.error.code)));
      if (this.state.lookup?.status === "paid" && lookup.status !== "paid") {
        this.update({ message: "Giữ biên nhận đã xác minh. Phản hồi API mới chưa khớp trạng thái đã lưu; cần người vận hành đối chiếu." });
        return;
      }
      let announcement = this.state.announcement;
      if (lookup.status === "paid") {
        const event = receiptEventKey(lookup.receipt), key = `intracampus.pos.paid.${id}`;
        if (!this.announced.has(event) && this.stored(key) !== event) {
          this.announced.add(event); this.stored(key, event); announcement = "Đã xác minh thanh toán hóa đơn.";
        }
      } else {
        const retryable = lookup.status !== "rpc-error" || lookup.error.retryable;
        if (retryable) {
          nextDelay = 2000;
          if (lookup.status === "rpc-error") {
            this.failures++; const backoff = Math.min(30000, 2000 * 2 ** Math.min(this.failures - 1, 4));
            const header = response.headers.get("Retry-After");
            const ms = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : NaN;
            // Browser timers support signed 32-bit delays. Invalid/unsupported headers use B02 backoff.
            nextDelay = Number.isFinite(ms) && ms >= 0 && ms <= 2147483647 ? Math.max(2000, ms) : backoff;
          } else this.failures = 0;
        }
      }
      const pendingHash = lookup.transaction?.status === "unverified" ? lookup.transaction.txHash
        : lookup.status !== "paid" && this.hint !== sentHint ? this.hint ?? null : null;
      this.stored(`intracampus.pos.hash.${id}`, pendingHash ?? ""); this.hint = pendingHash ?? undefined;
      this.update({ lookup, envelope: lookup.envelope, pendingHash, announcement,
        message: "error" in lookup && lookup.error ? `${lookup.error.message} ${lookup.error.nextStep}` : null });
    } catch (error) {
      if (this.disposed || generation !== this.generation || request.signal.aborted) return;
      this.failures++;
      this.update({ message: error instanceof TypeError || error instanceof SyntaxError
        ? "Chưa đọc được phản hồi hợp lệ từ API. Giữ invoiceId và hash cũ để thử tra cứu lại."
        : error instanceof Error ? error.message : "Chưa đọc được trạng thái hóa đơn." });
      if (this.state.lookup?.status !== "paid") nextDelay = Math.min(30000, 2000 * 2 ** Math.min(this.failures - 1, 4));
    } finally {
      if (!this.disposed && generation === this.generation) {
        this.update({ busy: false }); if (nextDelay !== undefined) this.retry(nextDelay);
      }
    }
  }
  dispose() { this.disposed = true; this.generation++; this.request?.abort(); this.clearTimer(); this.listeners.clear(); }
}
