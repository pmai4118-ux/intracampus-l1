"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ParkingCheckout } from "@intracampus/network";
import { librarySessionMessage, LibrarySessionError, signInLibraryWallet } from "../../../../../lib/library-session";
import { formatCheckoutTime, ParkingCheckoutError, readParkingCheckout } from "../../../../../lib/parking";
import { useCampusWallet } from "../../../../student/WalletPanel";

const messages: Record<string, string> = {
  PARKING_TICKET_NOT_FOUND: "Không tìm thấy vé bãi xe. Kiểm tra lại mã QR tại quầy.",
  PARKING_PAYMENT_REQUIRED: "Điểm thu chưa xác minh thanh toán cho vé này. Kiểm tra lại với quầy.",
  UNAUTHENTICATED: "Đăng nhập bằng ví nhân viên để xác nhận lượt ra.",
  FORBIDDEN: "Phiên đăng nhập chưa có quyền xác nhận tại cổng ra. Hãy dùng ví nhân viên demo.",
};

export default function ParkingGateCheckout({ invoiceId }: { invoiceId: string }) {
  const { state: wallet, controller } = useCampusWallet();
  const [ticket, setTicket] = useState<ParkingCheckout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void readParkingCheckout(invoiceId, { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setTicket(result);
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        const code = cause instanceof ParkingCheckoutError ? cause.code : "UNAVAILABLE";
        setError(messages[code] ?? "Chưa đọc được vé. Vui lòng thử lại.");
      }
    });
    return () => controller.abort();
  }, [invoiceId, attempt]);

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      setTicket(await readParkingCheckout(invoiceId, { confirm: true }));
      setNeedsSignIn(false);
    } catch (cause) {
      const code = cause instanceof ParkingCheckoutError ? cause.code : "UNAVAILABLE";
      setError(messages[code] ?? "Chưa xác nhận được lượt ra. Vui lòng thử lại.");
      setNeedsSignIn(code === "UNAUTHENTICATED" || code === "FORBIDDEN");
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    if (!wallet.address) return;
    setBusy(true);
    setError(null);
    try {
      await signInLibraryWallet(wallet.address, "LIBRARIAN", (account, message) => controller.signMessage(account, message));
      setNeedsSignIn(false);
    } catch (cause) {
      const code = cause instanceof LibrarySessionError ? cause.code : "WALLET_UNAVAILABLE";
      setError(["FORBIDDEN", "WALLET_SESSION_CHANGED"].includes(code)
        ? "Hãy chọn ví nhân viên demo trong Core rồi đăng nhập lại."
        : librarySessionMessage(code));
    } finally {
      setBusy(false);
    }
  }

  return <section className="surface-panel parking-checkout-panel" aria-label="Vé bãi xe" aria-busy={busy}>
    <div>
      {ticket ? <h2>Vé {ticket.invoiceCode}</h2> : null}
      {error ? <p className="wallet-warning" role="alert">{error}</p> : null}
      {!ticket && !error ? <p role="status">Đang kiểm tra vé…</p> : null}
      {ticket?.checkedOutAt != null ? <>
        <p className="verified-badge" role="status">Đã checkout · {formatCheckoutTime(ticket.checkedOutAt)}</p>
        <p>Lượt ra của vé này đã được ghi nhận.</p>
      </> : null}
      {ticket?.checkedOutAt === null ? <p>Vé đã thanh toán và đang chờ ra. Xác nhận khi sinh viên tới cổng.</p> : null}
      <div className="inline-actions">
        {!ticket && error ? <button className="secondary-btn" type="button" onClick={() => { setError(null); setAttempt(attempt + 1); }}>Kiểm tra lại vé</button> : null}
        {ticket?.checkedOutAt === null && !needsSignIn ? <button className="primary-cta-btn" type="button" disabled={busy} onClick={() => void checkout()}>
          {busy ? "Đang xác nhận…" : "Xác nhận ra bãi xe"}
        </button> : null}
        {needsSignIn && (wallet.status === "no-wallet" ? <p>Mở lại liên kết QR trong trình duyệt có ví Core để đăng nhập.</p>
          : !wallet.address ? <button className="secondary-btn" type="button" disabled={wallet.status === "connecting"} onClick={() => void controller.connect()}>Kết nối ví Core</button>
          : wallet.chainId !== BigInt(20261) ? <button className="secondary-btn" type="button" onClick={() => void controller.switchNetwork()}>Chuyển sang IntraCampus L1</button>
          : <button className="primary-cta-btn" type="button" disabled={busy} onClick={() => void signIn()}>{busy ? "Đang đăng nhập…" : "Đăng nhập bằng ví nhân viên"}</button>)}
        <Link href="/staff/parking" className="secondary-btn">Quét vé khác</Link>
      </div>
    </div>
  </section>;
}
