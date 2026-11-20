"use client";
import { CAMPUS_CHAIN_ID } from "@intracampus/network";


import Link from "next/link";
import { useEffect, useState } from "react";
import type { ParkingCheckout } from "@intracampus/network";
import { LibrarySessionError, signInLibraryWallet } from "../../../../../lib/library-session";
import { formatCheckoutTime, ParkingCheckoutError, readParkingCheckout } from "../../../../../lib/parking";
import HashChip from "../../../../components/HashChip";
import Icon from "../../../../components/Icon";
import { useCampusWallet } from "../../../../student/WalletPanel";

const messages: Record<string, string> = {
  PARKING_TICKET_NOT_FOUND: "Không tìm thấy vé bãi xe. Kiểm tra lại mã QR tại quầy.",
  PARKING_PAYMENT_REQUIRED: "Điểm thu chưa xác minh thanh toán cho vé này. Kiểm tra lại với quầy.",
  UNAUTHENTICATED: "Ký đăng nhập bằng ví Parking để xác nhận lượt ra.",
  FORBIDDEN: "Hãy chọn đúng ví Parking trong Core rồi đăng nhập lại.",
  CONFIGURATION_ERROR: "Dịch vụ cổng ra chưa được cấu hình.",
};

const signInMessages: Record<string, string> = {
  UNAUTHENTICATED: "Phiên ký đã hết hạn hoặc ví chưa được cấp quyền cổng ra. Kiểm tra ví Parking rồi thử lại.",
  FORBIDDEN: "Không được phép đăng nhập tại cổng ra. Kiểm tra địa chỉ trang và ví Parking.",
  WALLET_SESSION_CHANGED: "Phiên đăng nhập hoặc ví trong Core đã thay đổi. Chọn lại ví Parking.",
  WALLET_UNAVAILABLE: "Chưa nhận được chữ ký đăng nhập. Mở Core và kiểm tra yêu cầu ký.",
  RATE_LIMITED: "Bạn đã thử đăng nhập quá nhiều lần. Đợi một lúc rồi thử lại.",
  CONFIGURATION_ERROR: "Dịch vụ đăng nhập cổng ra chưa được cấu hình.",
};

export default function ParkingGateCheckout({ invoiceId, parkingWallet }: { invoiceId: string; parkingWallet?: string }) {
  const { state: wallet, controller } = useCampusWallet();
  const [ticket, setTicket] = useState<ParkingCheckout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abortController = new AbortController();
    void readParkingCheckout(invoiceId, { signal: abortController.signal }).then((result) => {
      if (!abortController.signal.aborted) setTicket(result);
    }).catch((cause) => {
      if (!abortController.signal.aborted) {
        const code = cause instanceof ParkingCheckoutError ? cause.code : "UNAVAILABLE";
        setError(messages[code] ?? "Chưa đọc được vé. Vui lòng thử lại.");
      }
    });
    return () => abortController.abort();
  }, [invoiceId, attempt]);

  async function checkout() {
    if (!correctChain || !operatorMatches) return;
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
    if (!wallet.address || !correctChain || !operatorMatches) return;
    setBusy(true);
    setError(null);
    try {
      await signInLibraryWallet(wallet.address, "PARKING", (account, message) => controller.signMessage(account, message));
      setNeedsSignIn(false);
    } catch (cause) {
      const code = cause instanceof LibrarySessionError ? cause.code : "WALLET_UNAVAILABLE";
      setError(signInMessages[code] ?? "Chưa đăng nhập được tại cổng ra. Kiểm tra Core rồi thử lại.");
    } finally {
      setBusy(false);
    }
  }

  const isLoading = !ticket && !error;
  const isCheckedOut = ticket?.checkedOutAt != null;
  const isReadyToExit = ticket?.checkedOutAt === null;
  const correctChain = wallet.chainId === BigInt(CAMPUS_CHAIN_ID);
  const operatorMatches = !!parkingWallet && wallet.address?.toLowerCase() === parkingWallet.toLowerCase();
  const canUseGate = correctChain && operatorMatches;
  const cardTone = isCheckedOut ? "is-checked-out" : isReadyToExit ? "is-ready" : error ? "is-error" : "";

  return (
    <div className="parking-checkout-layout">
      <section
        className={`surface-panel parking-checkout-panel gate-pass-card ${cardTone}`}
        aria-label="Vé bãi xe"
        aria-busy={busy || isLoading}
      >
        <div className="gate-pass-hero">
          <div className="gate-pass-badge-row">
            {isCheckedOut ? (
              <span className="receipt-hero-icon" aria-hidden="true">
                <Icon name="check" />
              </span>
            ) : isReadyToExit ? (
              <span className="gate-status-icon is-ready" aria-hidden="true">
                <Icon name="qr" />
              </span>
            ) : error ? (
              <span className="gate-status-icon is-error" aria-hidden="true">
                <Icon name="shield" />
              </span>
            ) : null}

            {isCheckedOut ? (
              <p className="verified-badge" role="status">
                Đã checkout · {formatCheckoutTime(ticket.checkedOutAt!)}
              </p>
            ) : isReadyToExit ? (
              <span className="parking-ticket-status gate-ready-pill">
                <span className="mode-status-dot dot-live" aria-hidden="true" />
                ĐÃ THANH TOÁN · CHỜ RA BÃI
              </span>
            ) : isLoading ? (
              <span className="network-pill">Đang đối chiếu vé</span>
            ) : (
              <span className="network-pill pill-danger">Cần kiểm tra lại</span>
            )}
          </div>

          {ticket ? <h2 className="gate-pass-code tabular-nums">Vé {ticket.invoiceCode}</h2> : null}
          {isLoading ? (
            <>
              <p role="status">Đang kiểm tra vé…</p>
              <div className="l1-shimmer-track" aria-hidden="true">
                <div className="l1-shimmer-bar" />
              </div>
            </>
          ) : null}
          {isCheckedOut ? (
            <p className="gate-pass-subtitle">
              Lượt ra của vé này đã được ghi nhận. Không dùng lại mã QR cho lượt khác.
            </p>
          ) : null}
          {isReadyToExit ? (
            <p className="gate-pass-subtitle">
              Vé đã thanh toán và đang chờ ra. Xác nhận khi sinh viên tới cổng.
            </p>
          ) : null}
        </div>

        <div className="receipt-tear-line gate-pass-tear" aria-hidden="true" />

        <dl className="price-breakdown tabular-nums">
          <div className="price-row">
            <dt>Mã hóa đơn (invoiceId)</dt>
            <dd>
              <HashChip value={invoiceId} start={8} end={6} copyLabel="Sao chép invoiceId" />
            </dd>
          </div>
          {ticket ? (
            <>
              <div className="price-row">
                <dt>Mã vé</dt>
                <dd>
                  <code className="mono-badge">{ticket.invoiceCode}</code>
                </dd>
              </div>
              <div className="price-row">
                <dt>Trạng thái cổng ra</dt>
                <dd>
                  {isCheckedOut
                    ? `Đã ra lúc ${formatCheckoutTime(ticket.checkedOutAt!)}`
                    : "Hợp lệ · Chờ xác nhận ra"}
                </dd>
              </div>
            </>
          ) : null}
        </dl>

        {error ? (
          <p className="wallet-warning" role="alert">
            {error}
          </p>
        ) : null}

        <div className="inline-actions gate-checkout-actions">
          {!ticket && error ? (
            <button
              className="secondary-btn"
              type="button"
              onClick={() => {
                setError(null);
                setAttempt((prev) => prev + 1);
              }}
            >
              Kiểm tra lại vé
            </button>
          ) : null}

          {isReadyToExit && canUseGate && !needsSignIn ? (
            <button
              className="primary-cta-btn gate-confirm-btn"
              type="button"
              disabled={busy}
              onClick={() => void checkout()}
            >
              <Icon name="check" />
              {busy ? "Đang xác nhận…" : "Xác nhận ra bãi xe"}
            </button>
          ) : null}

          {isReadyToExit && (!canUseGate || needsSignIn) &&
            (!parkingWallet ? (
              <p className="wallet-warning">Chưa có ví Parking được cấu hình cho cổng ra.</p>
            ) : wallet.status === "no-wallet" ? (
              <p className="wallet-warning">
                Mở lại liên kết QR trong trình duyệt có ví Core để đăng nhập.
              </p>
            ) : !wallet.address ? (
              <button
                className="primary-cta-btn"
                type="button"
                disabled={wallet.status === "connecting"}
                onClick={() => void controller.connect()}
              >
                Kết nối ví Core
              </button>
            ) : !correctChain ? (
              <button
                className="primary-cta-btn"
                type="button"
                onClick={() => void controller.switchNetwork()}
              >
                Chuyển sang IntraCampus L1
              </button>
            ) : !operatorMatches ? (
              <p className="wallet-warning">Chọn ví Parking {parkingWallet.slice(0, 6)}…{parkingWallet.slice(-4)} trong Core để xác nhận lượt ra.</p>
            ) : (
              <button
                className="primary-cta-btn"
                type="button"
                disabled={busy}
                onClick={() => void signIn()}
              >
                {busy ? "Đang đăng nhập…" : "Đăng nhập bằng ví Parking"}
              </button>
            ))}

          <Link href="/staff/parking" className={isCheckedOut ? "primary-cta-btn" : "secondary-btn"}>
            <Icon name="qr" />
            Quét vé khác
          </Link>
        </div>
      </section>

      <aside className="surface-panel gate-operator-card" aria-labelledby="gate-operator-title">
        <div className="panel-heading-with-icon">
          <span className="panel-icon icon-blue">
            <Icon name="wallet" />
          </span>
          <div>
            <span className="panel-eyebrow">PHIÊN NHÂN VIÊN</span>
            <h2 id="gate-operator-title">Ví xác nhận tại cổng</h2>
          </div>
        </div>
        <dl className="price-breakdown tabular-nums">
          <div className="price-row">
            <dt>Mạng</dt>
            <dd>
              <span className={`network-pill ${correctChain ? "pill-ok" : wallet.status === "wrong-chain" ? "pill-danger" : ""}`}>
                <span className="status-dot" aria-hidden="true" />
                {wallet.chainId === null ? "Chưa kết nối" : correctChain ? `Chain ${CAMPUS_CHAIN_ID}` : `Chain ${wallet.chainId.toString()}`}
              </span>
            </dd>
          </div>
          <div className="price-row">
            <dt>Ví hiện tại</dt>
            <dd>
              {wallet.address ? (
                <HashChip value={wallet.address} copyLabel="Sao chép ví nhân viên" />
              ) : (
                <span>Chưa kết nối</span>
              )}
            </dd>
          </div>
        </dl>
        <p className="metric-note">
          Xác nhận lượt ra chỉ ký đăng nhập phiên một lần trên thiết bị bảo vệ và không phát sinh phí gas khi bấm cho xe ra.
        </p>
      </aside>
    </div>
  );
}
