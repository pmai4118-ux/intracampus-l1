"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { SignedInvoiceEnvelope } from "@intracampus/network";
import { formatWalletBalance } from "../../lib/chains";
import { parseInvoicePayload, sameInvoiceEnvelope } from "../../lib/invoice";

type CreatedInvoice = {
  invoiceId: string;
  status: "pending";
  envelope: SignedInvoiceEnvelope;
  qrPayload: string;
  pricingPreview?: unknown;
  transaction: null;
};

const service = { merchantId: "parking-demo", serviceId: "parking-single" } as const;

function apiMessage(value: unknown) {
  if (!value || typeof value !== "object" || !("error" in value)) return "Chưa tạo được hóa đơn. Kiểm tra kết nối rồi thử lại.";
  const error = (value as { error?: { message?: unknown } }).error;
  return typeof error?.message === "string" ? error.message : "Chưa tạo được hóa đơn. Kiểm tra kết nối rồi thử lại.";
}

export function InvoiceForm() {
  const [invoice, setInvoice] = useState<CreatedInvoice | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setQrImage(null);
    if (invoice) {
      void QRCode.toDataURL(invoice.qrPayload, { errorCorrectionLevel: "Q", margin: 2, width: 360 })
        .then((image) => { if (!cancelled) setQrImage(image); })
        .catch(() => { if (!cancelled) setError("Không tạo được mã QR. Bạn vẫn có thể sao chép payload để dán vào Student."); });
    }
    return () => { cancelled = true; };
  }, [invoice]);

  async function createInvoice() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch("/api/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(service),
        cache: "no-store",
      });
      const body: unknown = await response.json();
      if (!response.ok || !body || typeof body !== "object") throw new Error(apiMessage(body));
      const record = body as Record<string, unknown>;
      if (typeof record.qrPayload !== "string" || typeof record.invoiceId !== "string" || !record.envelope
        || record.status !== "pending" || record.transaction !== null) {
        throw new Error("Backend trả về hóa đơn chưa đúng định dạng.");
      }
      const envelope = parseInvoicePayload(record.qrPayload);
      const responseEnvelope = parseInvoicePayload(JSON.stringify(record.envelope));
      if (envelope.invoice.invoiceId.toLowerCase() !== record.invoiceId.toLowerCase()
        || !sameInvoiceEnvelope(envelope, responseEnvelope)) {
        throw new Error("Mã hóa đơn và payload không khớp.");
      }
      setInvoice({ invoiceId: record.invoiceId, status: "pending", envelope, qrPayload: record.qrPayload,
        pricingPreview: record.pricingPreview, transaction: null });
    } catch (cause) {
      setInvoice(null);
      setError(cause instanceof Error ? cause.message : "Chưa tạo được hóa đơn. Kiểm tra kết nối rồi thử lại.");
    } finally {
      setBusy(false);
    }
  }

  async function copyPayload() {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(invoice.qrPayload);
      setCopied(true);
      setError(null);
    } catch {
      setError("Không truy cập được clipboard. Chọn và sao chép payload trong ô bên dưới.");
    }
  }

  const remaining = invoice ? Math.max(0, invoice.envelope.invoice.expiresAt * 1000 - now) : 0;
  const minutes = Math.floor(remaining / 60_000).toString().padStart(2, "0");
  const seconds = Math.floor((remaining % 60_000) / 1000).toString().padStart(2, "0");

  return <section className="surface-panel invoice-form-panel" aria-labelledby="invoice-form-title" aria-busy={busy}>
    <div className="panel-top-row">
      <div>
        <h1 id="invoice-form-title" className="screen-title">Tạo hóa đơn POS</h1>
        <p className="screen-subtitle">Bãi xe demo · Một lượt gửi xe · giá gốc 3.000 CAMPUS</p>
      </div>
      <span className="network-pill pill-ok"><span className="status-dot" aria-hidden="true" />IntraCampus L1 · Chain 20261</span>
    </div>

    <div className="invoice-form-actions">
      <p>Backend ấn định giá và ký payload hóa đơn. Giao dịch CAMPUS (nếu sinh viên xác nhận) sẽ do ví Core của sinh viên ký.</p>
      <button type="button" className="primary-cta-btn" disabled={busy} onClick={() => void createInvoice()}>
        {busy ? "Đang tạo hóa đơn…" : invoice ? "Tạo hóa đơn mới" : "Tạo hóa đơn"}
      </button>
    </div>

    {error ? <p className="invoice-feedback error-panel" role="alert">{error}</p> : null}
    {invoice ? <div className="invoice-form-result" aria-live="polite">
      <div className="invoice-qr-card">
        {qrImage ? <img src={qrImage} alt={`Mã QR cho hóa đơn ${invoice.envelope.meta.invoiceCode}`} width={320} height={320} />
          : <p role="status">Đang tạo mã QR…</p>}
        <span className="metric-note">Quét bằng Core hoặc dán payload trên trang Student.</span>
      </div>
      <div className="invoice-preview-data">
        <span className="verified-badge">HÓA ĐƠN ĐÃ KÝ · CHỜ THANH TOÁN</span>
        <h2>{invoice.envelope.meta.serviceName}</h2>
        <p>Nơi thu: {invoice.envelope.meta.merchantName}</p>
        <dl className="price-breakdown">
          <div className="price-row"><dt>Giá gốc</dt><dd className="tabular-value">{formatWalletBalance(BigInt(invoice.envelope.invoice.amount))}</dd></div>
          <div className="price-row"><dt>Mã hóa đơn</dt><dd><code>{invoice.envelope.meta.invoiceCode}</code></dd></div>
          <div className="price-row"><dt>Còn hiệu lực</dt><dd className="tabular-value">{remaining > 0 ? `${minutes}:${seconds}` : "Đã hết hạn"}</dd></div>
          <div className="price-row"><dt>Người nhận</dt><dd><code>{invoice.envelope.invoice.merchant}</code></dd></div>
        </dl>
        <p className="invoice-direction-note">POS chỉ phát hành hóa đơn. Chỉ receipt/event đã xác minh mới chứng minh đã trả tiền.</p>
        <button type="button" className="secondary-btn" onClick={() => void copyPayload()}>
          {copied ? "Đã sao chép payload" : "Sao chép payload QR"}
        </button>
        <label className="invoice-payload-label" htmlFor="invoice-payload">Payload để dán khi camera không dùng được</label>
        <textarea id="invoice-payload" className="invoice-payload" readOnly value={invoice.qrPayload} rows={5} />
      </div>
    </div> : <p className="invoice-empty-state">Tạo hóa đơn để hiện QR và thời hạn thật từ chain.</p>}
  </section>;
}
