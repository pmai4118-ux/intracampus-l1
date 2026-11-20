"use client";

import { useEffect, useId, useState } from "react";
import { isParkingInvoice, requireDeployment } from "@intracampus/network";
import { browserWalletConfig, formatWalletBalance } from "../../lib/chains";
import { InvoicePreviewError, verifyInvoicePreview } from "../../lib/invoice";
import { librarySessionMessage, LibrarySessionError, requireLibraryStudentNotHeld } from "../../lib/library-session";
import { PaymentController, restorePaymentPreview, type InvoicePreview, type PaymentSnapshot } from "../../lib/payment";
import { createWalletRpc } from "../../lib/wallet";
import { Receipt } from "../pos/Receipt";
import { CopyButton } from "../demo-controls";
import HashChip from "../components/HashChip";
import Icon from "../components/Icon";
import TransactionStepper, { type StepState } from "../components/TransactionStepper";
import { useCampusWallet } from "./WalletPanel";

function paymentStep(status?: PaymentSnapshot["status"]): StepState {
  if (!status || status === "ready" || status === "quote-changed") return "idle";
  if (status === "preflight") return "checking";
  if (status === "signing") return "signing";
  if (status === "pending" || status === "unknown") return "confirming";
  if (status === "paid") return "done";
  return "error";
}

function paymentErrorStep(payment: PaymentSnapshot | null, lastStep: 0 | 1 | 2): 0 | 1 | 2 {
  if (!payment) return 0;
  if (payment.status === "reverted" || payment.txHash) return 2;
  return lastStep;
}

export function PayInvoice({
  preview,
  onPaid,
  compact = false,
}: {
  preview: InvoicePreview;
  onPaid?: (hash: string) => void;
  compact?: boolean;
}) {
  const { state: wallet, controller: walletController, access, signingIn, signIn, refreshAccess } = useCampusWallet();
  const [controller, setController] = useState<PaymentController | null>(null);
  const [payment, setPayment] = useState<PaymentSnapshot | null>(null);
  const [lastStep, setLastStep] = useState<0 | 1 | 2>(0);
  useEffect(() => { if (payment?.status === "paid" && payment.receipt) onPaid?.(payment.receipt.txHash); }, [payment?.status, payment?.receipt?.txHash, onPaid]);
  useEffect(() => {
    if (!payment) return;
    if (payment.status === "preflight" || payment.status === "ready" || payment.status === "quote-changed") setLastStep(0);
    else if (payment.status === "signing") setLastStep(1);
    else if (payment.status === "pending" || payment.status === "unknown" || payment.status === "reverted") setLastStep(2);
  }, [payment?.status]);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [manualHash, setManualHash] = useState("");
  const id = useId();
  useEffect(() => {
    if (!wallet.address) return;
    let session: PaymentController;
    let unsubscribe: (() => void) | undefined;
    try {
      // Environment-only addresses and local fixtures cannot turn on production payments.
      const deployment = requireDeployment();
      if (preview.envelope.domain.chainId !== deployment.chainId
        || preview.envelope.domain.verifyingContract.toLowerCase() !== deployment.contracts.CampusPaymentRegistry.address.toLowerCase()
        || preview.envelope.signer.toLowerCase() !== deployment.roles.posSigner.toLowerCase()) throw Error();
      const config = browserWalletConfig();
      if (!config.rpcUrl || !navigator.locks) throw Error();
      const rpc = createWalletRpc(config.rpcUrl);
      session = new PaymentController({
        preview, account: wallet.address, storage: window.localStorage, wallet: walletController,
        preflight: async (payload, account, signal) => {
          try { await requireLibraryStudentNotHeld(account); }
          catch (error) { throw new InvoicePreviewError(error instanceof LibrarySessionError ? error.code : "SESSION_UNAVAILABLE"); }
          return verifyInvoicePreview(payload, account, config, rpc, signal);
        },
        exclusive: async (key, run) => {
          await navigator.locks.request(key, { mode: "exclusive", ifAvailable: true }, async (lock) => {
            if (!lock) throw Error("PAYMENT_LOCKED");
            await run();
          });
        }
      });
      setController(session); setPayment(session.getSnapshot()); setSetupError(null);
      unsubscribe = session.subscribe(() => setPayment(session.getSnapshot()));
      void session.refresh();
    } catch {
      setController(null); setPayment(null);
      setSetupError("Chưa có deployment L1 đã xác minh hoặc bộ nhớ/khóa trình duyệt không sẵn sàng. Mở trong Core qua HTTPS và kiểm tra cấu hình trước khi thanh toán.");
    }
    return () => { unsubscribe?.(); session?.dispose(); };
  }, [preview, wallet.address, walletController]);
  useEffect(() => {
    if (!controller || !payment || !["pending", "unknown"].includes(payment.status) || payment.busy) return;
    const timer = window.setTimeout(() => void controller.refresh(), 3000);
    return () => window.clearTimeout(timer);
  }, [controller, payment]);
  useEffect(() => {
    if (payment?.receipt?.txHash) void walletController.refresh();
  }, [payment?.receipt?.txHash, walletController]);

  const quote = payment?.preview.quote ?? preview.quote;
  const locked = !wallet.canProceed || wallet.chainId !== BigInt(20261) || access?.status !== "ready";
  const parking = isParkingInvoice(preview.envelope);
  const showSummary = !compact || payment?.status === "quote-changed";
  if (payment?.status === "paid" && payment.receipt) return <section className={`invoice-payment-panel${compact ? " invoice-payment-compact" : ""}`} aria-labelledby={`${id}-title`}>
    <TransactionStepper state="done" />
    <h4 id={`${id}-title`}>Thanh toán đã xác minh</h4>
    <p role="status">{parking ? "Đã check-in bãi xe. Khi ra, mở vé trong ví để bảo vệ quét QR." : "Khoản thanh toán đã hoàn tất. Bạn có thể tiếp tục sử dụng dịch vụ khác."}</p>
    {parking ? <div className="inline-actions"><a className="primary-cta-btn" href="#parking-tickets"><Icon name="qr" />Xem QR vé gửi xe</a></div> : null}
    <Receipt receipt={payment.receipt} />
  </section>;
  return <section className={`invoice-payment-panel${compact ? " invoice-payment-compact" : ""}`} aria-labelledby={`${id}-title`} aria-busy={payment?.busy}>
    <h4 id={`${id}-title`}>Thanh toán bằng ví sinh viên</h4>
    <p>Core sẽ yêu cầu xác nhận giao dịch tới payment registry. Gas được tính riêng.</p>
    <TransactionStepper state={paymentStep(payment?.status)} errorStep={paymentErrorStep(payment, lastStep)} />
    <div className="payment-meta-summary">
      <div className="payment-meta-row">
        <span>Ví trả</span>
        <HashChip value={wallet.address ?? ""} copyLabel="Sao chép địa chỉ ví trả" />
      </div>
      {showSummary ? <>
        <div className="payment-meta-row">
          <span>Người nhận CAMPUS</span>
          <HashChip value={preview.envelope.invoice.merchant} copyLabel="Sao chép địa chỉ người nhận" />
        </div>
        <div className="payment-meta-row payment-meta-amount">
          <span>Số tiền cần xác nhận</span>
          <strong className="tabular-nums">{formatWalletBalance(quote.paidAmount)}</strong>
        </div>
      </> : null}
    </div>
    {payment?.status === "quote-changed" ? <dl className="price-breakdown tabular-nums">
      <div className="price-row"><dt>Giá gốc mới kiểm tra</dt><dd>{formatWalletBalance(quote.originalAmount)}</dd></div>
      <div className="price-row discount-row"><dt>Ưu đãi hiện tại</dt><dd>{formatWalletBalance(quote.discountAmount)}</dd></div>
    </dl> : null}
    {setupError ? <p className="wallet-warning" role="alert">{setupError}</p> : null}
    {access?.status !== "ready" ? <div className="wallet-warning" role={access?.status === "held" || access?.status === "error" ? "alert" : "status"}>
      <p>{access?.status === "held" ? librarySessionMessage("ACCOUNT_HELD")
        : access?.status === "error" ? librarySessionMessage(access.code)
          : access?.status === "sign-in-required" ? librarySessionMessage("UNAUTHENTICATED") : "Đang kiểm tra session và Library hold…"}</p>
      {access?.status === "held" ? <p>Mã khoản mượn đang chặn: {access.accountStatus.blockingLoanIds.join(", ") || "chưa có"}</p> : null}
      <div className="inline-actions">
        {access?.status === "sign-in-required" || access?.status === "error" ? <button type="button" className="secondary-btn"
          disabled={!wallet.address || wallet.chainId !== BigInt(20261) || signingIn}
          onClick={() => void signIn()}>{signingIn ? "Đang chờ ký trong Core…" : "Đăng nhập bằng ví sinh viên"}</button> : null}
        <button type="button" className="secondary-btn" disabled={!wallet.address || signingIn} onClick={() => void refreshAccess()}>Kiểm tra session và hold</button>
      </div>
    </div> : null}
    {payment?.message ? <p className="wallet-status" role="status">{payment.message}</p> : null}
    {payment?.txHash ? <><p>Tx hash</p><code className="tx-hash-code">{payment.txHash}</code>
      <CopyButton label="Sao chép hash thanh toán" value={payment.txHash} /></> : null}
    {payment?.canRecoverHash ? <div>
      <label htmlFor={`${id}-hash`}>Hash từ lịch sử Core để đối chiếu</label>
      <p>Hash nhập tay còn cần xác minh. Bạn có thể sửa khi sao chép nhầm; lượt gửi ban đầu vẫn được giữ và chưa được gửi lại.</p>
      <input id={`${id}-hash`} className="invoice-payload" value={manualHash} onChange={(event) => setManualHash(event.target.value)} autoComplete="off" spellCheck={false} />
      <button type="button" className="secondary-btn" disabled={payment.busy || !manualHash.trim()} onClick={() => void controller?.refresh(manualHash.trim())}>Tra cứu hash cũ</button>
    </div> : null}
    <div className="inline-actions invoice-preview-actions">
      {payment?.canPay ? <button type="button" className="primary-cta-btn" disabled={locked || payment.busy}
        onClick={() => void controller?.pay()}>{payment.status === "quote-changed" ? "Xác nhận giá mới và mở Core" : "Thanh toán bằng Core"}</button> : null}
      {controller && !payment?.canPay && payment?.status !== "paid" ? <button type="button" className="secondary-btn" disabled={payment?.busy}
        onClick={() => void controller.refresh()}>Tra cứu kết quả cũ</button> : null}
    </div>
    {payment?.receipt ? <Receipt receipt={payment.receipt} /> : null}
  </section>;
}

/** Reload recovery does not require re-validating an expired/already-paid QR first. */
export function PaymentRecovery() {
  const { state: wallet } = useCampusWallet();
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [error, setError] = useState(false);
  const [isPaid, setIsPaid] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setPreview(null); setError(false); setIsPaid(false); setCollapsed(false); setDismissed(false);
    if (!wallet.address) return;
    try { setPreview(restorePaymentPreview(window.localStorage, wallet.address)); }
    catch { setError(true); }
  }, [wallet.address]);
  if (error) return <p className="wallet-warning" role="alert">Không đọc được lần thanh toán đã lưu. Giữ invoiceId/hash từ Core và đối chiếu trên POS trước khi ký thêm.</p>;
  if (!preview) return null;
  if (isPaid && dismissed) {
    return (
      <section className="recovery-dismissed-bar" aria-label="Khôi phục thanh toán">
        <span>Biên lai gần nhất ({preview.envelope.meta.invoiceCode}) đã xác minh.</span>
        <button type="button" className="text-action-btn" onClick={() => { setDismissed(false); setCollapsed(false); }}>
          Hiện lại biên lai
        </button>
      </section>
    );
  }
  return (
    <section className="surface-panel recovery-panel" aria-label="Khôi phục thanh toán">
      <div className="recovery-header-row">
        <div className="recovery-header-meta">
          <h3>Lần thanh toán đã lưu</h3>
          <div className="recovery-id-line">
            <span className="status-id-label">invoiceId</span>
            <HashChip value={preview.envelope.invoice.invoiceId} start={6} end={4} copyLabel="Sao chép invoiceId" />
          </div>
        </div>
        {isPaid ? (
          <div className="recovery-header-actions">
            <button type="button" className="text-action-btn" onClick={() => setCollapsed((prev) => !prev)}>
              {collapsed ? "Mở rộng" : "Thu gọn"}
            </button>
            <button type="button" className="text-action-btn" onClick={() => setDismissed(true)}>
              Ẩn biên lai cũ
            </button>
          </div>
        ) : null}
      </div>
      {collapsed ? (
        <p className="metric-note">
          Biên lai đã xác minh. Bấm Mở rộng để xem lại chi tiết hoặc bấm Ẩn biên lai cũ.
        </p>
      ) : (
        <PayInvoice preview={preview} onPaid={() => setIsPaid(true)} />
      )}
    </section>
  );
}
