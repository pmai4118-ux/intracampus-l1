"use client";
import { Receipt } from "./Receipt";
import type { InvoiceStatusSnapshot } from "../../lib/invoice-status";
import Icon from "../components/Icon";
import HashChip from "../components/HashChip";

export function InvoiceStatus({ state }: { state: InvoiceStatusSnapshot }) {
  const lookup = state.lookup;
  const labels = { pending: "Chờ thanh toán / xác minh", expired: "Hóa đơn đã hết hạn",
    "rpc-error": "Chưa đọc được mạng để xác minh", paid: "Đã xác minh thanh toán" };
  return <section className="surface-panel pos-status-panel" aria-labelledby="pos-payment-status">
    <div className="panel-heading-with-icon"><span className="panel-icon"><Icon name={lookup?.status === "paid" ? "check" : "clock"} /></span><span className="panel-eyebrow">02 · THEO DÕI THANH TOÁN</span></div>
    <h2 id="pos-payment-status">{lookup ? labels[lookup.status] : state.invoiceId ? "Đang tra cứu hóa đơn" : "Chưa có hóa đơn đang theo dõi"}</h2>
    {lookup?.status === "pending" || Boolean(state.pendingHash) ? (
      <div className="l1-shimmer-track" aria-hidden="true">
        <div className="l1-shimmer-bar" />
      </div>
    ) : null}
    {!lookup && !state.invoiceId && !state.announcement ? <p className="muted-line">Tạo hóa đơn mới ở khung bên trái hoặc nhập invoiceId bên dưới để tự động theo dõi trạng thái biên nhận.</p> : null}
    <p role="status">{state.announcement}</p>
    {state.storageWarning ? <p className="wallet-warning" role="alert">{state.storageWarning}</p> : null}
    {state.message ? <p className="wallet-warning" role="alert">{state.message}</p> : null}
    {state.invoiceId ? <div className="status-id-row">
      <span className="status-id-label">invoiceId</span>
      <HashChip value={state.invoiceId} start={8} end={6} copyLabel="Sao chép invoiceId" />
    </div> : null}
    {state.pendingHash && !lookup?.transaction ? <><p>Hash đang chờ đối chiếu; chưa gửi lại thanh toán.</p><div className="status-id-row"><span className="status-id-label">TxHash</span><HashChip value={state.pendingHash} start={10} end={8} copyLabel="Sao chép mã giao dịch" /></div></> : null}
    {lookup?.status === "expired" ? <p>Không ký thanh toán mới cho hóa đơn này. POS vẫn đối chiếu giao dịch cũ để tìm biên nhận đến muộn.</p> : null}
    {lookup?.status === "rpc-error" ? <p>Trạng thái trước đó: {lookup.lastKnownStatus === "expired" ? "hết hạn" : lookup.lastKnownStatus === "pending" ? "đang chờ" : "chưa xác minh"}. Giữ hash giao dịch cũ.</p> : null}
    {lookup?.transaction && lookup.status !== "paid" ? <><p>{lookup.transaction.status === "unverified"
      ? "Giao dịch chưa xác minh; không gửi lại thanh toán."
      : lookup.transaction.status === "reverted" ? "Giao dịch đã revert; chưa thu được tiền." : "Event giao dịch không khớp hóa đơn; chưa xác nhận thanh toán."}</p>
      <div className="status-id-row"><span className="status-id-label">TxHash</span><HashChip value={lookup.transaction.txHash} start={10} end={8} copyLabel="Sao chép mã giao dịch" /></div></> : null}
    {lookup?.status === "paid" ? <Receipt receipt={lookup.receipt} /> : null}
  </section>;
}
