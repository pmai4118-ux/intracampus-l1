"use client";
import { formatWalletBalance } from "../../lib/chains";
import type { InvoiceStatusSnapshot } from "../../lib/invoice-status";
import { CopyButton } from "../demo-controls";

export function InvoiceStatus({ state }: { state: InvoiceStatusSnapshot }) {
  const lookup = state.lookup;
  const labels = { pending: "Chờ thanh toán / xác minh", expired: "Hóa đơn đã hết hạn",
    "rpc-error": "Chưa đọc được mạng để xác minh", paid: "Đã xác minh thanh toán" };
  return <section className="surface-panel" aria-labelledby="pos-payment-status">
    <h2 id="pos-payment-status">{lookup ? labels[lookup.status] : state.invoiceId ? "Đang tra cứu hóa đơn" : "Chưa có hóa đơn đang theo dõi"}</h2>
    <p role="status">{state.announcement}</p>
    {state.storageWarning ? <p className="wallet-warning" role="alert">{state.storageWarning}</p> : null}
    {state.message ? <p className="wallet-warning" role="alert">{state.message}</p> : null}
    {state.invoiceId ? <><p>invoiceId</p><code className="tx-hash-code">{state.invoiceId}</code>
      <CopyButton label="Sao chép invoiceId" value={state.invoiceId} /></> : null}
    {state.pendingHash && !lookup?.transaction ? <><p>Hash đang chờ đối chiếu; chưa gửi lại thanh toán.</p><code className="tx-hash-code">{state.pendingHash}</code></> : null}
    {lookup?.status === "expired" ? <p>Không ký thanh toán mới cho hóa đơn này. POS vẫn đối chiếu giao dịch cũ để tìm biên nhận đến muộn.</p> : null}
    {lookup?.status === "rpc-error" ? <p>Trạng thái trước đó: {lookup.lastKnownStatus === "expired" ? "hết hạn" : lookup.lastKnownStatus === "pending" ? "đang chờ" : "chưa xác minh"}. Giữ hash giao dịch cũ.</p> : null}
    {lookup?.transaction && lookup.status !== "paid" ? <><p>{lookup.transaction.status === "unverified"
      ? "Giao dịch chưa xác minh; không gửi lại thanh toán."
      : lookup.transaction.status === "reverted" ? "Giao dịch đã revert; chưa thu được tiền." : "Event giao dịch không khớp hóa đơn; chưa xác nhận thanh toán."}</p>
      <code className="tx-hash-code">{lookup.transaction.txHash}</code></> : null}
    {lookup?.status === "paid" ? <div className="invoice-verified-preview">
      <span className="verified-badge">BIÊN NHẬN ĐÃ XÁC MINH</span>
      <dl className="price-breakdown">
        <div className="price-row"><dt>Mã hóa đơn</dt><dd>{lookup.receipt.invoiceCode}</dd></div>
        <div className="price-row"><dt>Giá gốc</dt><dd>{formatWalletBalance(BigInt(lookup.receipt.originalAmount))}</dd></div>
        <div className="price-row"><dt>Ưu đãi (tier {lookup.receipt.tier})</dt><dd>{formatWalletBalance(BigInt(lookup.receipt.discountAmount))}</dd></div>
        <div className="price-row"><dt>Đã trả</dt><dd>{formatWalletBalance(BigInt(lookup.receipt.paidAmount))}</dd></div>
        <div className="price-row"><dt>Gas (riêng)</dt><dd>{formatWalletBalance(BigInt(lookup.receipt.gasUsed) * BigInt(lookup.receipt.effectiveGasPrice))}</dd></div>
        <div className="price-row"><dt>Block / log</dt><dd>{lookup.receipt.blockNumber} / {lookup.receipt.logIndex}</dd></div>
      </dl>
      <p>Người trả</p><code className="tx-hash-code">{lookup.receipt.payer}</code>
      <p>Người nhận</p><code className="tx-hash-code">{lookup.receipt.merchant}</code>
      <p>Hợp đồng · chain {lookup.receipt.chainId}</p><code className="tx-hash-code">{lookup.receipt.contractAddress}</code>
      <p>Tx hash</p><code className="tx-hash-code">{lookup.receipt.txHash}</code>
      <CopyButton label="Sao chép tx hash" value={lookup.receipt.txHash} />
    </div> : null}
  </section>;
}
