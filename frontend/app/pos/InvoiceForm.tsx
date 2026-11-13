"use client";

import QRCode from "qrcode";
import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { formatWalletBalance } from "../../lib/chains";
import { parseInvoicePayload, sameInvoiceEnvelope } from "../../lib/invoice";
import { InvoiceStatusController } from "../../lib/invoice-status";
import { InvoiceStatus } from "./InvoiceStatus";

const service = { merchantId: "parking-demo", serviceId: "parking-single" } as const;
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
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [lookupId, setLookupId] = useState("");
  const [txHash, setTxHash] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const unresolved = state.lookup?.transaction?.status === "unverified" || Boolean(state.pendingHash);
  useEffect(() => { setLookupId(state.invoiceId ?? ""); setTxHash(""); }, [state.invoiceId]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    let cancelled = false; setQrImage(null);
    if (qrPayload) void QRCode.toDataURL(qrPayload, { errorCorrectionLevel: "Q", margin: 2, width: 360 })
      .then((image) => { if (!cancelled) setQrImage(image); })
      .catch(() => { if (!cancelled) setError("Không tạo được mã QR. Bạn vẫn có thể sao chép payload để dán vào Student."); });
    return () => { cancelled = true; };
  }, [qrPayload]);
  async function createInvoice() {
    if (busy || unresolved) return;
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
      await tracker.watch(record.invoiceId, envelope);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Chưa tạo được hóa đơn. Kiểm tra kết nối rồi thử lại."); }
    finally { setBusy(false); }
  }
  async function recover(event: FormEvent) {
    event.preventDefault(); setLookupError(null);
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
  const countdown = `${Math.floor(remaining / 60000).toString().padStart(2, "0")}:${Math.floor((remaining % 60000) / 1000).toString().padStart(2, "0")}`;
  return <>
    <section className="surface-panel invoice-form-panel" aria-labelledby="invoice-form-title" aria-busy={busy}>
      <div className="panel-top-row"><div><h1 id="invoice-form-title" className="screen-title">Tạo hóa đơn POS</h1>
        <p className="screen-subtitle">Bãi xe demo · Một lượt gửi xe · giá gốc 3.000 CAMPUS</p></div>
        <span className="network-pill">IntraCampus L1 · Chain 20261</span></div>
      <div className="invoice-form-actions"><p>Backend ấn định giá và ký hóa đơn. Sinh viên xác nhận thanh toán bằng ví Core.</p>
        <button type="button" className="primary-cta-btn" disabled={busy || unresolved} onClick={() => void createInvoice()}>
          {busy ? "Đang tạo hóa đơn…" : state.invoiceId ? "Tạo hóa đơn mới" : "Tạo hóa đơn"}</button></div>
      {unresolved ? <p>Đang đối chiếu giao dịch cũ; giữ hóa đơn hiện tại tới khi xác minh được kết quả.</p> : null}
      {error ? <p className="invoice-feedback error-panel" role="alert">{error}</p> : null}
      {invoice ? <div className="invoice-form-result">
        <div className="invoice-qr-card">{qrImage ? <img src={qrImage} alt={`Mã QR cho hóa đơn ${invoice.meta.invoiceCode}`} width={320} height={320} /> : <p role="status">Đang tạo mã QR…</p>}
          <span className="metric-note">Quét trên trang Student hoặc dán cùng payload.</span></div>
        <div className="invoice-preview-data"><h2>{invoice.meta.serviceName}</h2><p>Nơi thu: {invoice.meta.merchantName}</p>
          <dl className="price-breakdown"><div className="price-row"><dt>Giá gốc</dt><dd>{formatWalletBalance(BigInt(invoice.invoice.amount))}</dd></div>
            <div className="price-row"><dt>Mã hóa đơn</dt><dd><code>{invoice.meta.invoiceCode}</code></dd></div>
            <div className="price-row"><dt>Còn hiệu lực (đồng hồ thiết bị)</dt><dd>{remaining > 0 ? countdown : "Đã hết thời gian hiển thị"}</dd></div>
            <div className="price-row"><dt>Người nhận</dt><dd><code>{invoice.invoice.merchant}</code></dd></div></dl>
          <p>Trạng thái thanh toán và hết hạn được xác minh qua API; đồng hồ thiết bị chỉ hỗ trợ hiển thị.</p>
          <button type="button" className="secondary-btn" onClick={() => void copyPayload()}>{copied ? "Đã sao chép payload" : "Sao chép payload QR"}</button>
          <label className="invoice-payload-label" htmlFor="invoice-payload">Payload để dán khi camera không dùng được</label>
          <textarea id="invoice-payload" className="invoice-payload" readOnly value={qrPayload} rows={5} />
        </div></div> : <p>Tạo hóa đơn hoặc nhập invoiceId bên dưới để mở lại hóa đơn cũ.</p>}
    </section>
    <InvoiceStatus state={state} />
    <form className="surface-panel invoice-recovery" onSubmit={(event) => void recover(event)} aria-labelledby="invoice-recovery-title">
      <h2 id="invoice-recovery-title">Mở lại / đối chiếu hóa đơn</h2>
      <label htmlFor="pos-invoice-id">invoiceId</label><input id="pos-invoice-id" required value={lookupId} onChange={(e) => { setLookupId(e.target.value); setLookupError(null); }}
        aria-invalid={Boolean(lookupError)} aria-describedby="pos-lookup-help pos-lookup-error" autoComplete="off" spellCheck={false} />
      <label htmlFor="pos-tx-hash">Tx hash (nếu đã có)</label><input id="pos-tx-hash" value={txHash} onChange={(e) => { setTxHash(e.target.value); setLookupError(null); }}
        aria-invalid={Boolean(lookupError)} aria-describedby="pos-lookup-help pos-lookup-error" autoComplete="off" spellCheck={false} />
      <p id="pos-lookup-help">Chỉ tra cứu giao dịch cũ. Hash đang chưa xác minh được giữ ở backend; không gửi lại thanh toán.</p>
      <p id="pos-lookup-error" role="alert">{lookupError}</p>
      <button className="secondary-btn" type="submit" disabled={state.busy || busy}>{state.busy ? "Đang tra cứu…" : "Tra cứu hóa đơn"}</button>
    </form>
  </>;
}
