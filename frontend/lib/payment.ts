import type { InvoiceLookupResponse, SignedInvoiceEnvelope, VerifiedInvoiceReceipt } from "@intracampus/network";
import { isWalletAddress } from "./chains.ts";
import { encodePayInvoiceSimulation, InvoicePreviewError, parseInvoicePayload, sameInvoiceEnvelope, type InvoicePreviewQuote } from "./invoice.ts";
import { isInvoiceHash, parseInvoiceLookup } from "./invoice-status.ts";
import { WalletTransactionError, type WalletSnapshot, type WalletTransaction } from "./wallet.ts";

export type InvoicePreview = { envelope: SignedInvoiceEnvelope; quote: InvoicePreviewQuote };
type PaymentRecord = { version: 1; account: string; envelope: SignedInvoiceEnvelope; amountWei: string; txHash: string | null };
export type PaymentSnapshot = {
  status: "ready" | "preflight" | "quote-changed" | "signing" | "pending" | "unknown" | "paid" | "blocked" | "reverted" | "error";
  preview: InvoicePreview; txHash: string | null; receipt: VerifiedInvoiceReceipt | null;
  message: string | null; busy: boolean; canPay: boolean;
};
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Options = {
  preview: InvoicePreview; account: string; storage: StorageLike;
  wallet: { getSnapshot(): WalletSnapshot; sendTransaction(account: string, transaction: WalletTransaction): Promise<string> };
  preflight(payload: string, account: string, signal: AbortSignal): Promise<InvoicePreview>;
  fetcher?: typeof fetch;
  exclusive?: (key: string, run: () => Promise<void>) => Promise<void>;
};
const inFlight = new Set<string>();
export const paymentStorageKey = (envelope: SignedInvoiceEnvelope) =>
  `intracampus.student.payment.v1.${envelope.domain.chainId}.${envelope.domain.verifyingContract.toLowerCase()}.${envelope.invoice.invoiceId.toLowerCase()}`;
const activeKey = (account: string) => `intracampus.student.payment.active.v1.${account.toLowerCase()}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameQuote = (a: InvoicePreviewQuote, b: InvoicePreviewQuote) => a.tier === b.tier && a.originalAmount === b.originalAmount
  && a.discountAmount === b.discountAmount && a.paidAmount === b.paidAmount;
export function restorePaymentPreview(storage: StorageLike, account: string): InvoicePreview | null {
  const key = storage.getItem(activeKey(account));
  if (!key) return null;
  const raw = storage.getItem(key); if (!raw) return null;
  const saved = JSON.parse(raw) as PaymentRecord;
  const envelope = parseInvoicePayload(JSON.stringify(saved.envelope));
  if (saved.version !== 1 || !isWalletAddress(saved.account) || !same(saved.account, account) || key !== paymentStorageKey(envelope)
    || typeof saved.amountWei !== "string" || !/^[1-9][0-9]{0,77}$/.test(saved.amountWei)) throw Error("INVALID_PAYMENT_JOURNAL");
  const originalAmount = BigInt(envelope.invoice.amount), paidAmount = BigInt(saved.amountWei);
  if (paidAmount !== originalAmount && paidAmount !== originalAmount - originalAmount / BigInt(10)) throw Error("INVALID_PAYMENT_JOURNAL");
  return { envelope, quote: { tier: paidAmount === originalAmount ? 0 : 1, originalAmount, paidAmount,
    discountAmount: originalAmount - paidAmount, blockNumber: "0x0", blockTimestamp: BigInt(0) } };
}
const messageFor = (code: string) => ({
  INVOICE_EXPIRED: "Hóa đơn đã hết hạn. Yêu cầu POS tạo hóa đơn mới.",
  INVOICE_ALREADY_PAID: "Hóa đơn đã được thanh toán. Đối chiếu biên lai cũ, không trả thêm.",
  WRONG_CHAIN: "Hãy chuyển ví và RPC về IntraCampus L1 · chain 20261.",
  INVALID_SIGNATURE: "Chữ ký hóa đơn chưa hợp lệ. Yêu cầu POS kiểm tra và tạo lại.",
  WALLET_SESSION_CHANGED: "Tài khoản hoặc mạng đã đổi. Kiểm tra lại hóa đơn bằng ví muốn trả tiền.",
  WALLET_REQUEST_PENDING: "Ví đang có yêu cầu chờ. Mở Core để xử lý yêu cầu cũ.",
  PAYMENT_SIMULATION_FAILED: "Mô phỏng thanh toán chưa thành công. Kiểm tra số dư, hạn hóa đơn và mạng rồi thử lại.",
}[code] ?? "Chưa xác minh được điều kiện thanh toán. Kiểm tra kết nối rồi thử lại.");

/** Student payment journal. A hash, expiry or network error never implies a failed payment. */
export class PaymentController {
  private state: PaymentSnapshot;
  private listeners = new Set<() => void>();
  private record: PaymentRecord | null = null;
  private stopped = false;
  private operation = false;
  private abort = new AbortController();
  private readonly key: string;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
    this.key = paymentStorageKey(options.preview.envelope);
    this.state = { status: "ready", preview: options.preview, txHash: null, receipt: null, message: null, busy: false, canPay: true };
    try {
      const raw = options.storage.getItem(this.key);
      if (raw !== null) {
        const saved = JSON.parse(raw) as PaymentRecord;
        if (saved.version !== 1 || !isWalletAddress(saved.account) || !sameInvoiceEnvelope(parseInvoicePayload(JSON.stringify(saved.envelope)), options.preview.envelope)
          || typeof saved.amountWei !== "string" || !/^[1-9][0-9]{0,77}$/.test(saved.amountWei)
          || (saved.txHash !== null && (!isInvoiceHash(saved.txHash) || /^0x0{64}$/i.test(saved.txHash)))) throw Error();
        this.record = saved;
        this.state = { ...this.state, status: saved.txHash ? "pending" : "unknown", txHash: saved.txHash, canPay: false,
          message: "Đã khôi phục lần yêu cầu thanh toán trước. Tra cứu kết quả, không gửi lại." };
        if (!same(saved.account, options.account)) this.state = { ...this.state, status: "blocked",
          message: `Hóa đơn đã có yêu cầu từ ví ${saved.account}. Chuyển về ví đó để đối chiếu; không trả thêm bằng ví hiện tại.` };
      }
    } catch {
      this.state = { ...this.state, status: "blocked", canPay: false,
        message: "Không đọc được nhật ký thanh toán an toàn. Giữ invoiceId/hash và nhờ người vận hành đối chiếu trước khi tiếp tục." };
    }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<PaymentSnapshot>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener();
  }
  private currentWallet() {
    const wallet = this.options.wallet.getSnapshot();
    if (this.stopped || !wallet.canProceed || !wallet.address || !same(wallet.address, this.options.account) || wallet.chainId !== BigInt(20261)) {
      throw new WalletTransactionError("WALLET_SESSION_CHANGED", "not-sent");
    }
  }
  private persist(record: PaymentRecord) {
    this.options.storage.setItem(this.key, JSON.stringify(record));
    this.options.storage.setItem(activeKey(record.account), this.key);
    // Storage failures must be detected before opening the signing request.
    if (this.options.storage.getItem(this.key) !== JSON.stringify(record)) throw Error();
    this.record = record;
  }
  async pay() {
    if (this.options.exclusive) {
      try { await this.options.exclusive(this.key, () => this.payLocked()); }
      catch { this.update({ message: "Một cửa sổ khác đang xử lý hóa đơn hoặc khóa trình duyệt chưa sẵn sàng. Tra cứu lần cũ trước khi tiếp tục." }); }
      return;
    }
    await this.payLocked();
  }
  private async payLocked() {
    if (this.stopped || this.operation || !this.state.canPay || this.record || inFlight.has(this.key)) return;
    this.operation = true; inFlight.add(this.key);
    this.update({ status: "preflight", busy: true, canPay: false, message: "Đang kiểm tra lại giá, hạn hóa đơn và mô phỏng thanh toán…" });
    let openingWallet = false;
    try {
      this.currentWallet();
      const fresh = await this.options.preflight(JSON.stringify(this.state.preview.envelope), this.options.account, this.abort.signal);
      this.currentWallet();
      if (!sameInvoiceEnvelope(fresh.envelope, this.state.preview.envelope)) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
      if (!sameQuote(fresh.quote, this.state.preview.quote)) {
        this.update({ status: "quote-changed", preview: fresh, canPay: true,
          message: "Giá hoặc ưu đãi đã thay đổi. Đọc số tiền mới và bấm xác nhận lần nữa để tiếp tục." });
        return;
      }
      // Re-read storage after async preflight: another mounted panel may have already submitted.
      if (this.options.storage.getItem(this.key) !== null) {
        this.update({ status: "blocked", canPay: false, message: "Đã có yêu cầu cho hóa đơn này. Tải lại và tra cứu lần thanh toán trước." }); return;
      }
      const record: PaymentRecord = { version: 1, account: this.options.account, envelope: fresh.envelope, amountWei: fresh.quote.paidAmount.toString(), txHash: null };
      this.persist(record);
      this.update({ status: "signing", preview: fresh, message: "Mở Core để kiểm tra mạng, người nhận, số CAMPUS và gas rồi xác nhận." });
      openingWallet = true;
      const txHash = await this.options.wallet.sendTransaction(this.options.account, {
        to: fresh.envelope.domain.verifyingContract, data: encodePayInvoiceSimulation(fresh.envelope), value: `0x${fresh.quote.paidAmount.toString(16)}`,
      });
      record.txHash = txHash; this.record = record;
      try { this.persist(record); }
      catch { this.update({ message: "Đã có hash nhưng không lưu được. Sao chép hash trước khi đóng trang; chưa gửi lại." }); }
      this.update({ status: "pending", txHash, canPay: false });
    } catch (error) {
      if (openingWallet && error instanceof WalletTransactionError && error.outcome !== "unknown") {
        try { this.options.storage.removeItem(this.key); this.record = null; }
        catch { this.update({ status: "blocked", canPay: false, message: "Không cập nhật được nhật ký. Giữ invoiceId và tra cứu trước khi thử tiếp." }); return; }
        this.update({ status: "error", canPay: true, message: error.outcome === "rejected" ? "Bạn đã từ chối ký. Chưa gửi thanh toán; có thể kiểm tra rồi thử lại." : messageFor(error.code) });
      } else if (openingWallet) {
        this.update({ status: "unknown", canPay: false, message: "Chưa rõ ví đã gửi giao dịch hay chưa. Mở lịch sử Core lấy hash rồi tra cứu; không ký lại hóa đơn này." });
      } else if (this.record) {
        this.update({ status: "blocked", canPay: false, message: "Không lưu được đầy đủ nhật ký. Tra cứu hóa đơn trước khi tiếp tục." });
      } else {
        this.update({ status: "error", canPay: true, message: error instanceof InvoicePreviewError || error instanceof WalletTransactionError
          ? messageFor(error.code) : "Không lưu hoặc kiểm tra được phiên thanh toán. Chưa mở ví; thử lại khi kết nối và bộ nhớ sẵn sàng." });
      }
    } finally {
      this.operation = false; inFlight.delete(this.key); this.update({ busy: false });
    }
    if (this.record?.txHash && !this.stopped) await this.refresh();
  }
  async refresh(manualHash?: string) {
    if (this.stopped || this.operation || this.state.busy || this.state.status === "paid") return;
    if (this.record && !same(this.record.account, this.options.account)) return;
    if (manualHash !== undefined) {
      if (!isInvoiceHash(manualHash) || /^0x0{64}$/i.test(manualHash)) { this.update({ message: "Hash phải là mã hex 32 byte từ lịch sử Core." }); return; }
      if (!this.record || (this.record.txHash && !same(this.record.txHash, manualHash))) {
        this.update({ message: "Giữ hash đang theo dõi; không thay bằng giao dịch khác." }); return;
      }
      this.record.txHash = manualHash;
      try { this.persist(this.record); } catch { /* Keep the hash in memory and show it below. */ }
      this.update({ txHash: manualHash });
    }
    this.update({ busy: true });
    try {
      const envelope = this.state.preview.envelope, hash = this.record?.txHash;
      const response = await (this.options.fetcher ?? fetch)(`/api/invoices/${envelope.invoice.invoiceId}${hash ? `?txHash=${hash}` : ""}`,
        { cache: "no-store", signal: this.abort.signal });
      if (![200, 422, 503].includes(response.status)) throw Error();
      const lookup: InvoiceLookupResponse = parseInvoiceLookup(await response.json(), envelope.invoice.invoiceId, envelope);
      if ((response.status === 503) !== (lookup.status === "rpc-error")) throw Error();
      if (response.status === 422 && (lookup.status === "paid" || !lookup.error
        || !["TX_REVERTED", "RECEIPT_EVENT_MISMATCH"].includes(lookup.error.code))) throw Error();
      if (lookup.status === "paid") {
        const r = lookup.receipt;
        if (!this.record || !same(r.payer, this.record.account) || (hash && !same(r.txHash, hash)) || BigInt(r.paidAmount) !== BigInt(this.record.amountWei)) {
          this.update({ status: "blocked", canPay: false, message: "Hóa đơn đã có biên lai, nhưng không khớp lần ký đang theo dõi. Đối chiếu trên POS; không trả thêm." }); return;
        }
        this.record.txHash = r.txHash;
        try { this.persist(this.record); } catch { /* The verified receipt remains visible for copying. */ }
        this.update({ status: "paid", txHash: r.txHash, receipt: r, canPay: false, message: "Thanh toán của ví này đã được xác minh. POS có thể đọc cùng biên lai." });
      } else if (lookup.transaction?.status === "reverted" && hash && same(lookup.transaction.txHash, hash)) {
        this.update({ status: "reverted", canPay: false, message: "Giao dịch đã revert, chưa thanh toán. Gas có thể đã bị tính; yêu cầu POS tạo hóa đơn mới sau khi kiểm tra." });
      } else {
        this.update({ status: this.record ? hash ? "pending" : "unknown" : "ready", canPay: !this.record,
          message: lookup.status === "rpc-error" ? "Mất kết nối xác minh. Giữ hash cũ và thử tra cứu lại; không gửi lại." :
            lookup.transaction?.status === "event-mismatch" ? "Event chưa khớp hóa đơn. Giữ hash để đối chiếu; chưa xác nhận thanh toán." :
              this.record ? "Chưa có biên lai đã xác minh. Tiếp tục tra cứu lần gửi cũ, kể cả khi hóa đơn hết hạn." : null });
      }
    } catch {
      this.update({ message: "Chưa đọc được biên lai hợp lệ. Giữ invoiceId/hash và thử tra cứu lại; chưa gửi lại thanh toán." });
    } finally { this.update({ busy: false }); }
  }
  dispose() { this.stopped = true; this.abort.abort(); this.listeners.clear(); }
}
