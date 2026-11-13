"use client";
import { Receipt } from "./Receipt";
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
    {lookup?.status === "paid" ? <Receipt receipt={lookup.receipt} /> : null}
  </section>;
}
