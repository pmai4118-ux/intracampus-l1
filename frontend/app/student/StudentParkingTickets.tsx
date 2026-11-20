"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import type { OpenParkingTicket } from "@intracampus/network";
import { formatCheckoutTime, ParkingCheckoutError, parkingCheckoutPath, readOpenParkingTickets } from "../../lib/parking";
import { librarySessionMessage } from "../../lib/library-session";
import { CopyButton } from "../demo-controls";
import Icon from "../components/Icon";
import { useCampusWallet } from "./WalletPanel";

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

  return <li className="parking-ticket">
    <h3>Vé {ticket.invoiceCode}</h3>
    <p>Check-in lúc {formatCheckoutTime(ticket.checkedInAt)}</p>
    {qr ? <><img src={qr.image} width={224} height={224} alt={`QR ra bãi xe cho vé ${ticket.invoiceCode}`} />
      <CopyButton label={`Sao chép liên kết vé ${ticket.invoiceCode}`} value={qr.url} /></>
      : <p role="status">{error ? "Chưa tạo được QR. Tải lại vé để thử lại." : "Đang tạo QR…"}</p>}
  </li>;
}

function TicketsForWallet({ address }: { address: string }) {
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
        setError(null);
        timer = setTimeout(() => void refresh(), 4000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setTickets(null);
        setError(cause instanceof ParkingCheckoutError ? cause.code : "UNAVAILABLE");
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [accessStatus, address, attempt, signingIn]);

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

export default function StudentParkingTickets() {
  const { state } = useCampusWallet();
  return <section className="surface-panel student-parking-tickets" aria-labelledby="parking-tickets-title" id="parking-tickets">
    <div className="panel-heading-with-icon">
      <span className="panel-icon"><Icon name="qr" /></span><h2 id="parking-tickets-title">Vé gửi xe đang sử dụng</h2>
    </div>
    <p>Khi ra bãi, đưa QR của vé cho bảo vệ quét và xác nhận.</p>
    {state.address ? <TicketsForWallet key={state.address} address={state.address} /> : <p>Kết nối ví đã thanh toán để xem vé.</p>}
  </section>;
}
