"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { OpenParkingTicket } from "@intracampus/network";
import { formatCheckoutTime, ParkingCheckoutError, parkingCheckoutPath, readOpenParkingTickets } from "../../lib/parking";
import { librarySessionMessage } from "../../lib/library-session";
import { CopyButton } from "../demo-controls";
import Icon from "../components/Icon";
import { useCampusWallet } from "./WalletPanel";

function shortTicketCode(code: string) {
  if (code.length <= 28) return code;
  return `${code.slice(0, 20)}…${code.slice(-6)}`;
}

function TicketQr({ ticket }: { ticket: OpenParkingTicket }) {
  const [qr, setQr] = useState<{ url: string; image: string } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const url = new URL(parkingCheckoutPath(ticket.invoiceId), window.location.origin).href;
    void QRCode.toDataURL(url, { width: 224, margin: 4 }).then((image) => {
      if (active) setQr({ url, image });
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [ticket.invoiceId]);

  return <li className="parking-ticket parking-ticket-card">
    <div className="parking-ticket-head">
      <div className="parking-ticket-title-group">
        <span className="parking-ticket-status">
          <span className="mode-status-dot dot-live" aria-hidden="true" />
          Đang gửi
        </span>
        <h3 title={ticket.invoiceCode}>Vé {shortTicketCode(ticket.invoiceCode)}</h3>
      </div>
      <span className="parking-ticket-time tabular-nums">Check-in lúc {formatCheckoutTime(ticket.checkedInAt)}</span>
    </div>
    <div className="receipt-tear-line parking-ticket-tear" aria-hidden="true" />
    {qr ? <div className="parking-ticket-qr-wrap">
      <img src={qr.image} width={224} height={224} alt={`QR ra bãi xe cho vé ${ticket.invoiceCode}`} />
      <CopyButton label="Sao chép liên kết vé" value={qr.url} />
    </div>
      : <p role="status">{error ? "Chưa tạo được QR. Tải lại vé để thử lại." : "Đang tạo QR…"}</p>}
  </li>;
}

function TicketsForWallet({ address, onCountChange }: { address: string; onCountChange?: (count: number) => void }) {
  const { state, access, signIn, signingIn } = useCampusWallet();
  const [tickets, setTickets] = useState<OpenParkingTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const accessStatus = access?.status;

  useEffect(() => {
    if (signingIn) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await readOpenParkingTickets(address, controller.signal);
        if (controller.signal.aborted) return;
        setTickets(result);
        onCountChange?.(result.length);
        setError(null);
        timer = setTimeout(() => void refresh(), 4000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setTickets(null);
        onCountChange?.(0);
        setError(cause instanceof ParkingCheckoutError ? cause.code : "UNAVAILABLE");
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [accessStatus, address, attempt, signingIn, onCountChange]);

  if (error === "UNAUTHENTICATED" || error === "FORBIDDEN") return <>
    <p role="status">{access?.status === "error" && access.code !== "SESSION_UNAVAILABLE"
      ? librarySessionMessage(access.code) : "Đăng nhập bằng ví đã thanh toán để xem vé của bạn."}</p>
    <button type="button" className="secondary-btn" disabled={signingIn || state.chainId !== BigInt(20261)} onClick={() => void signIn()}>
      {signingIn ? "Đang chờ ký trong Core…" : "Đăng nhập để xem vé"}
    </button>
  </>;
  if (error) return <>
    <p role="alert">Chưa tải được vé bãi xe. Kiểm tra kết nối rồi thử lại.</p>
    <button type="button" className="secondary-btn" onClick={() => { setError(null); setAttempt((previous) => previous + 1); }}>Tải lại vé</button>
  </>;
  if (!tickets) return <p role="status">Đang tải vé bãi xe…</p>;
  if (!tickets.length) return <p role="status">Bạn không có vé đang gửi xe.</p>;
  return <ul className="parking-ticket-list">{tickets.map((ticket) => <TicketQr key={ticket.invoiceId} ticket={ticket} />)}</ul>;
}

export default function StudentParkingTickets({
  hidden = false,
  onCountChange,
}: {
  hidden?: boolean;
  onCountChange?: (count: number) => void;
} = {}) {
  const { state } = useCampusWallet();
  return <section className="surface-panel student-parking-tickets" aria-labelledby="parking-tickets-title" id="parking-tickets" hidden={hidden}>
    <div className="panel-heading-with-icon">
      <span className="panel-icon icon-blue"><Icon name="qr" /></span>
      <div>
        <span className="panel-eyebrow">VÉ GỬI XE ĐIỆN TỬ</span>
        <h2 id="parking-tickets-title">Vé gửi xe đang sử dụng</h2>
      </div>
      <span className="step-label">03 / 03</span>
    </div>
    <p>Khi ra bãi, đưa QR của vé cho bảo vệ quét và xác nhận.</p>
    {state.address ? <TicketsForWallet key={state.address} address={state.address} onCountChange={onCountChange} /> : <p>Kết nối ví đã thanh toán để xem vé.</p>}
  </section>;
}
