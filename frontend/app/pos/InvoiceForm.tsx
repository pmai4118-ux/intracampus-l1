"use client";
import { CAMPUS_CHAIN_ID } from "@intracampus/network";


import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { formatWalletBalance } from "../../lib/chains";
import { parseInvoicePayload, sameInvoiceEnvelope } from "../../lib/invoice";
import { renderInvoiceQr, type InvoiceQrImage } from "../../lib/invoice-qr";
import { InvoiceStatusController, POS_ACTIVE_PAYLOAD_KEY, receiptEventKey } from "../../lib/invoice-status";
import { InvoiceStatus } from "./InvoiceStatus";
import PosShiftLedger from "./PosShiftLedger";
import Icon from "../components/Icon";
import HashChip from "../components/HashChip";
import type { PosSessionLedgerEntry } from "../demo-fixtures";

const POS_SHIFT_HISTORY_KEY = "intracampus.pos.shift_history.v1";
const POS_AUTO_RENEW_KEY = "intracampus.pos.auto_renew.v1";
const AUTO_RENEW_DELAY_MS = 4000;
const service = { merchantId: "parking-demo", serviceId: "parking-single" } as const;

type LastPaidSummary = {
  invoiceId: string;
  invoiceCode: string;
  paidAmountWei: string;
  tier: 0 | 1;
  blockNumber: number;
};
function apiMessage(value: unknown) {
  if (!value || typeof value !== "object" || !("error" in value)) return "Chưa tạo được hóa đơn. Kiểm tra kết nối rồi thử lại.";
  const error = (value as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : "Chưa tạo được hóa đơn. Kiểm tra kết nối rồi thử lại.";
}
export function InvoiceForm() {
  const [tracker, setTracker] = useState<InvoiceStatusController | null>(null);
  useEffect(() => {
    const session = new InvoiceStatusController({ storage: {
      getItem: (key) => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) } });
    setTracker(session); void session.restore();
    return () => session.dispose();
  }, []);
  return tracker ? <InvoiceWorkspace tracker={tracker} /> : <p role="status">Đang khôi phục phiên POS…</p>;
}
function InvoiceWorkspace({ tracker }: { tracker: InvoiceStatusController }) {
  const state = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot);
  const invoice = state.envelope, qrPayload = invoice ? JSON.stringify(invoice) : "";
  const [qrImage, setQrImage] = useState<InvoiceQrImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [lookupId, setLookupId] = useState("");
  const [txHash, setTxHash] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [shiftHistory, setShiftHistory] = useState<PosSessionLedgerEntry[]>([]);
  const [autoRenew, setAutoRenew] = useState(true);
  const [autoRenewTarget, setAutoRenewTarget] = useState<{ invoiceId: string; deadlineMs: number } | null>(null);
  const [lastPaidSummary, setLastPaidSummary] = useState<LastPaidSummary | null>(null);
  const watchedUnpaidIds = useRef<Set<string>>(new Set());
  const autoRenewedReceipts = useRef<Set<string>>(new Set());
  const createInvoiceRef = useRef<() => Promise<void>>(async () => {});
  const unresolved = state.lookup?.transaction?.status === "unverified" || Boolean(state.pendingHash);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(POS_SHIFT_HISTORY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setShiftHistory(parsed.slice(0, 30));
      }
      if (window.localStorage.getItem(POS_AUTO_RENEW_KEY) === "0") {
        setAutoRenew(false);
      }
    } catch { /* Ignore storage unavailability */ }
  }, []);
  useEffect(() => {
    if (!state.invoiceId || !invoice) return;
    setShiftHistory(prev => {
      const existing = prev.find(item => item.invoiceId.toLowerCase() === state.invoiceId!.toLowerCase());
      const nextStatus = state.lookup?.status ?? existing?.status ?? "pending";
      const nextPaid = state.lookup?.status === "paid" ? state.lookup.receipt.paidAmount : existing?.paidAmountWei ?? null;
      const nextTier = state.lookup?.status === "paid" ? state.lookup.receipt.tier : existing?.tier ?? null;
      const nextTxHash = state.lookup?.status === "paid" ? state.lookup.receipt.txHash : state.lookup?.transaction?.txHash ?? existing?.txHash ?? null;
      const updatedEntry: PosSessionLedgerEntry = {
        invoiceId: state.invoiceId!,
        invoiceCode: invoice.meta.invoiceCode,
        serviceName: invoice.meta.serviceName,
        amountWei: invoice.invoice.amount,
        paidAmountWei: nextPaid,
        status: nextStatus,
        tier: nextTier,
        txHash: nextTxHash,
        createdAt: existing?.createdAt ?? invoice.meta.issuedAt * 1000,
      };
      const nextList = [
        updatedEntry,
        ...prev.filter(item => item.invoiceId.toLowerCase() !== state.invoiceId!.toLowerCase()),
      ].slice(0, 30);
      try { window.localStorage.setItem(POS_SHIFT_HISTORY_KEY, JSON.stringify(nextList)); } catch {}
      return nextList;
    });
  }, [state.invoiceId, state.lookup, invoice]);
  useEffect(() => {
    if (!state.invoiceId || !state.lookup) return;
    const id = state.invoiceId.toLowerCase();
    if (state.lookup.status !== "paid") {
      watchedUnpaidIds.current.add(id);
      return;
    }
    const receipt = state.lookup.receipt;
    const eventKey = receiptEventKey(receipt);
    const isNewlyConfirmed = state.announcement === "Đã xác minh thanh toán hóa đơn." || watchedUnpaidIds.current.has(id);
    watchedUnpaidIds.current.delete(id);
    if (isNewlyConfirmed && !autoRenewedReceipts.current.has(eventKey)) {
      autoRenewedReceipts.current.add(eventKey);
      setLastPaidSummary({
        invoiceId: receipt.invoiceId,
        invoiceCode: receipt.invoiceCode,
        paidAmountWei: receipt.paidAmount,
        tier: receipt.tier,
        blockNumber: receipt.blockNumber,
      });
      if (autoRenew) {
        setAutoRenewTarget({ invoiceId: state.invoiceId, deadlineMs: Date.now() + AUTO_RENEW_DELAY_MS });
      }
    }
  }, [state.invoiceId, state.lookup, state.announcement, autoRenew]);
  useEffect(() => { setLookupId(state.invoiceId ?? ""); setTxHash(""); }, [state.invoiceId]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    let cancelled = false; setQrImage(null);
    if (qrPayload) void renderInvoiceQr(qrPayload)
      .then((image) => { if (!cancelled) setQrImage(image); })
      .catch(() => { if (!cancelled) setError("Không tạo được mã QR. Bạn vẫn có thể sao chép payload để dán vào Student."); });
    return () => { cancelled = true; };
  }, [qrPayload]);
  useEffect(() => {
    try {
      if (qrPayload && state.lookup?.status !== "paid") window.localStorage.setItem(POS_ACTIVE_PAYLOAD_KEY, qrPayload);
      else window.localStorage.removeItem(POS_ACTIVE_PAYLOAD_KEY);
    } catch { /* Best-effort local tab bridge only. */ }
  }, [qrPayload, state.lookup?.status]);
  async function createInvoice() {
    if (busy || unresolved) return;
    setAutoRenewTarget(null);
    setBusy(true); setError(null); setCopied(false);
    try {
      const response = await fetch("/api/invoices", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(service), cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object") throw new Error(apiMessage(body));
      const record = body as Record<string, unknown>;
      if (typeof record.qrPayload !== "string" || typeof record.invoiceId !== "string" || !record.envelope
        || record.status !== "pending" || record.transaction !== null) throw new Error("Backend trả về hóa đơn chưa đúng định dạng.");
      const envelope = parseInvoicePayload(record.qrPayload);
      if (envelope.invoice.invoiceId.toLowerCase() !== record.invoiceId.toLowerCase()
        || !sameInvoiceEnvelope(envelope, parseInvoicePayload(JSON.stringify(record.envelope)))) throw new Error("Mã hóa đơn và payload không khớp.");
      watchedUnpaidIds.current.add(record.invoiceId.toLowerCase());
      await tracker.watch(record.invoiceId, envelope);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Chưa tạo được hóa đơn. Kiểm tra kết nối rồi thử lại."); }
    finally { setBusy(false); }
  }
  createInvoiceRef.current = createInvoice;
  useEffect(() => {
    if (!autoRenewTarget || !autoRenew) return;
    if (state.invoiceId !== autoRenewTarget.invoiceId || state.lookup?.status !== "paid") {
      setAutoRenewTarget(null);
      return;
    }
    const delay = Math.max(0, autoRenewTarget.deadlineMs - Date.now());
    const timer = window.setTimeout(() => {
      setAutoRenewTarget(null);
      void createInvoiceRef.current();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [autoRenewTarget, autoRenew, state.invoiceId, state.lookup?.status]);
  function toggleAutoRenew() {
    setAutoRenew((prev) => {
      const next = !prev;
      if (!next) setAutoRenewTarget(null);
      try { window.localStorage.setItem(POS_AUTO_RENEW_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }
  async function recover(event: FormEvent) {
    event.preventDefault(); setLookupError(null); setAutoRenewTarget(null);
    try {
      if (lookupId.trim().toLowerCase() === state.invoiceId) await tracker.refresh(txHash.trim() || undefined);
      else await tracker.watch(lookupId.trim(), undefined, txHash.trim() || undefined);
    } catch (cause) { setLookupError(cause instanceof Error ? cause.message : "Không tra cứu được hóa đơn."); }
  }
  async function copyPayload() {
    try { await navigator.clipboard.writeText(qrPayload); setCopied(true); }
    catch { setError("Không truy cập được clipboard. Chọn và sao chép payload trong ô bên dưới."); }
  }
  const remaining = invoice ? Math.max(0, invoice.invoice.expiresAt * 1000 - now) : 0;
  const ttlMs = invoice ? Math.max(1000, (invoice.invoice.expiresAt - invoice.meta.issuedAt) * 1000) : 300000;
  const ttlPct = invoice ? Math.min(100, Math.max(0, Math.round((remaining / ttlMs) * 100))) : 0;
  const countdown = `${Math.floor(remaining / 60000).toString().padStart(2, "0")}:${Math.floor((remaining % 60000) / 1000).toString().padStart(2, "0")}`;
  const paidReceipt = state.lookup?.status === "paid" ? state.lookup.receipt : null;
  const autoRenewRemainingSec =
    autoRenewTarget && autoRenew && state.invoiceId === autoRenewTarget.invoiceId && paidReceipt
      ? Math.max(1, Math.ceil((autoRenewTarget.deadlineMs - now) / 1000))
      : null;
  return <>
    <section className="surface-panel invoice-form-panel" aria-labelledby="invoice-form-title" aria-busy={busy}>
      <div className="panel-top-row"><div><span className="panel-eyebrow">01 · PHÁT HÀNH HÓA ĐƠN</span><h2 id="invoice-form-title" className="screen-title">Tạo hóa đơn POS</h2>
        <p className="screen-subtitle">Bãi xe demo · Một lượt gửi xe · giá gốc 3 CAMPUS (SBT 2,7 CAMPUS)</p></div>
        <span className="network-pill">IntraCampus L1 · Chain {CAMPUS_CHAIN_ID}</span></div>
      <div className="invoice-form-actions">
        <div className="invoice-form-copy">
          <p>Backend ấn định giá và ký hóa đơn. Sinh viên xác nhận thanh toán bằng ví Core.</p>
          <div className="pos-autorenew-row">
            <button
              type="button"
              className={`pos-autorenew-toggle ${autoRenew ? "is-on" : ""}`}
              aria-pressed={autoRenew}
              onClick={toggleAutoRenew}
            >
              <span className="autorenew-dot" aria-hidden="true" />
              Tự làm mới QR khi thu xong: <strong>{autoRenew ? "Đang bật" : "Đang tắt"}</strong>
            </button>
          </div>
        </div>
        <button type="button" className="primary-cta-btn" disabled={busy || unresolved} onClick={() => void createInvoice()}><Icon name="qr" />
          {busy ? "Đang tạo hóa đơn…" : state.invoiceId ? "Tạo hóa đơn mới" : "Tạo hóa đơn"}</button>
      </div>
      {unresolved ? <p>Đang đối chiếu giao dịch cũ; giữ hóa đơn hiện tại tới khi xác minh được kết quả.</p> : null}
      {error ? <p className="invoice-feedback error-panel" role="alert">{error}</p> : null}
      {invoice ? <div className="invoice-form-result">
        {paidReceipt ? <div className="pos-gate-pass" role="status">
          <div className="gate-pass-main">
            <span className="gate-pass-icon"><Icon name="check" /></span>
            <div>
              <span className="verified-badge">ĐÃ XÁC MINH THU TIỀN · CHECK-IN</span>
              <h3>Thực thu {formatWalletBalance(BigInt(paidReceipt.paidAmount))}</h3>
              <p>{paidReceipt.tier === 1 ? "Đã áp dụng ưu đãi thẻ sinh viên SBT (-10%)" : "Thu theo mức giá tiêu chuẩn"} · Block #{paidReceipt.blockNumber}</p>
              {autoRenewRemainingSec !== null ? (
                <p className="pos-autorenew-countdown">
                  Tự động tạo mã QR mới cho xe tiếp theo sau <strong>{autoRenewRemainingSec}s</strong>…
                </p>
              ) : null}
            </div>
          </div>
          <div className="gate-pass-actions">
            <button type="button" className="primary-cta-btn" disabled={busy || unresolved} onClick={() => void createInvoice()}>
              <Icon name="qr" />{autoRenewRemainingSec !== null ? "Làm mới QR ngay" : "Tạo lượt thu tiếp theo"}
            </button>
            {autoRenewRemainingSec !== null ? (
              <button type="button" className="secondary-btn" onClick={() => setAutoRenewTarget(null)}>
                Giữ biên lai này
              </button>
            ) : null}
          </div>
        </div> : null}
        {!paidReceipt && lastPaidSummary && lastPaidSummary.invoiceId.toLowerCase() !== state.invoiceId?.toLowerCase() ? (
          <div className="pos-last-paid-banner" role="status">
            <div className="last-paid-copy">
              <span className="last-paid-check" aria-hidden="true"><Icon name="check" /></span>
              <div>
                <strong>Lượt vừa thu xong ({lastPaidSummary.invoiceCode}): Đã nhận {formatWalletBalance(BigInt(lastPaidSummary.paidAmountWei))} · Đã check-in</strong>
                <p>Mã QR bên dưới đã tự động làm mới ({invoice.meta.invoiceCode}) — sẵn sàng cho xe tiếp theo quét.</p>
              </div>
            </div>
            <div className="last-paid-actions">
              <button type="button" className="secondary-btn btn-compact" disabled={busy || state.busy} onClick={() => { setAutoRenewTarget(null); void tracker.watch(lastPaidSummary.invoiceId); }}>
                Xem lại biên lai
              </button>
              <button type="button" className="text-action-btn" onClick={() => setLastPaidSummary(null)}>
                Ẩn
              </button>
            </div>
          </div>
        ) : null}
        <div className={`invoice-qr-card ${paidReceipt ? "qr-card-paid" : ""}`}>
          {paidReceipt ? <span className="verified-badge">ĐÃ THU TIỀN · HÓA ĐƠN HOÀN TẤT</span> : null}
          <div className="qr-image-wrap">
            {qrImage ? <img src={qrImage.src} alt={`Mã QR cho hóa đơn ${invoice.meta.invoiceCode}`}
              width={qrImage.displayWidth} height={qrImage.displayWidth} style={{ maxWidth: qrImage.displayWidth }} />
              : <p role="status">Đang tạo mã QR…</p>}
            {paidReceipt ? (
              <div className="qr-paid-overlay" aria-hidden="true">
                <span className="qr-paid-check"><Icon name="check" /></span>
                <strong>ĐÃ THU XONG</strong>
                <small>{autoRenewRemainingSec !== null ? `Đổi QR sau ${autoRenewRemainingSec}s` : "Không quét lại mã cũ"}</small>
              </div>
            ) : null}
          </div>
          {!paidReceipt ? <div className="pos-ttl-track" aria-hidden="true">
            <div className={`pos-ttl-fill ${remaining <= 30000 ? "ttl-danger" : remaining <= 90000 ? "ttl-warn" : ""}`} style={{ width: `${ttlPct}%` }} />
          </div> : null}
          <span className="metric-note">{paidReceipt ? (autoRenewRemainingSec !== null ? `Đang tự động cấp mã QR mới sau ${autoRenewRemainingSec} giây…` : "Mã QR cũ đã làm mờ để tránh quét nhầm. Bấm Tạo lượt thu tiếp theo ở trên.") : "Quét trên trang Student hoặc dùng nút lấy nhanh trên cùng trình duyệt."}</span></div>
        <div className="invoice-preview-data"><h2>{invoice.meta.serviceName}</h2><p>Nơi thu: {invoice.meta.merchantName}</p>
          <dl className="price-breakdown tabular-nums"><div className="price-row"><dt>Giá gốc</dt><dd className="tabular-nums">{formatWalletBalance(BigInt(invoice.invoice.amount))}</dd></div>
            <div className="price-row discount-row"><dt>Ưu đãi thẻ SBT (-10%)</dt><dd className="tabular-nums">{formatWalletBalance(BigInt(invoice.invoice.amount) - BigInt(invoice.invoice.amount) / BigInt(10))}</dd></div>
            <div className="price-row"><dt>Mã hóa đơn</dt><dd><code className="mono-badge">{invoice.meta.invoiceCode}</code></dd></div>
            <div className="price-row"><dt>Còn hiệu lực (đồng hồ thiết bị)</dt><dd className="tabular-value">{paidReceipt ? "Đã thanh toán" : remaining > 0 ? countdown : "Đã hết thời gian hiển thị"}</dd></div>
            <div className="price-row"><dt>Người nhận</dt><dd><HashChip value={invoice.invoice.merchant} copyLabel="Sao chép địa chỉ merchant" /></dd></div></dl>
          <p>Trạng thái thanh toán và hết hạn được xác minh qua API; đồng hồ thiết bị chỉ hỗ trợ hiển thị.</p>
          <div className="inline-actions">
            <button type="button" className={`secondary-btn ${copied ? "is-copied-btn" : ""}`} onClick={() => void copyPayload()}>
              <Icon name={copied ? "check" : "copy"} />
              {copied ? "Đã chép payload" : "Sao chép payload QR"}
            </button>
          </div>
          <details className="payload-panel">
            <summary>Payload để dán thủ công khi camera không dùng được</summary>
            <label className="invoice-payload-label" htmlFor="invoice-payload">Payload JSON đã ký</label>
            <textarea id="invoice-payload" className="invoice-payload" readOnly value={qrPayload} rows={4} />
          </details>
        </div></div> : <div className="pos-empty-state"><span className="empty-qr-icon"><Icon name="qr" /></span><h3>Sẵn sàng cho lượt thanh toán tiếp theo</h3><p>Tạo hóa đơn để hiển thị mã QR tại đây.<br />Sinh viên quét mã và xác nhận bằng ví của mình.</p><span className="empty-state-hint"><Icon name="shield" />Chỉ ghi nhận đã thu khi biên lai được xác minh</span></div>}
    </section>
    <InvoiceStatus state={state} />
    <form className="surface-panel invoice-recovery" onSubmit={(event) => void recover(event)} aria-labelledby="invoice-recovery-title">
      <span className="panel-eyebrow">TRA CỨU & KHÔI PHỤC</span><h2 id="invoice-recovery-title">Mở lại / đối chiếu hóa đơn</h2>
      <label htmlFor="pos-invoice-id">invoiceId</label><input id="pos-invoice-id" required value={lookupId} onChange={(e) => { setLookupId(e.target.value); setLookupError(null); }}
        aria-invalid={Boolean(lookupError)} aria-describedby="pos-lookup-help pos-lookup-error" autoComplete="off" spellCheck={false} />
      <label htmlFor="pos-tx-hash">Tx hash (nếu đã có)</label><input id="pos-tx-hash" value={txHash} onChange={(e) => { setTxHash(e.target.value); setLookupError(null); }}
        aria-invalid={Boolean(lookupError)} aria-describedby="pos-lookup-help pos-lookup-error" autoComplete="off" spellCheck={false} />
      <p id="pos-lookup-help">Chỉ tra cứu giao dịch cũ. Hash đang chưa xác minh được giữ ở backend; không gửi lại thanh toán.</p>
      <p id="pos-lookup-error" role="alert">{lookupError}</p>
      <button className="secondary-btn" type="submit" disabled={state.busy || busy}>{state.busy ? "Đang tra cứu…" : "Tra cứu hóa đơn"}</button>
    </form>
    <PosShiftLedger
      entries={shiftHistory}
      activeInvoiceId={state.invoiceId}
      busy={state.busy || busy}
      onSelectInvoice={(id) => { setAutoRenewTarget(null); void tracker.watch(id); }}
      onClearHistory={() => {
        setShiftHistory([]);
        try { window.localStorage.removeItem(POS_SHIFT_HISTORY_KEY); } catch {}
      }}
    />
  </>;
}
