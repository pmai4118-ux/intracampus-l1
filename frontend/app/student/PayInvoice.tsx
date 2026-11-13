"use client";

import { useEffect, useId, useState } from "react";
import { requireDeployment } from "@intracampus/network";
import { browserWalletConfig, formatWalletBalance } from "../../lib/chains";
import { verifyInvoicePreview } from "../../lib/invoice";
import { PaymentController, restorePaymentPreview, type InvoicePreview, type PaymentSnapshot } from "../../lib/payment";
import { createWalletRpc } from "../../lib/wallet";
import { Receipt } from "../pos/Receipt";
import { CopyButton } from "../demo-controls";
import { useCampusWallet } from "./WalletPanel";

export function PayInvoice({ preview }: { preview: InvoicePreview }) {
  const { state: wallet, controller: walletController } = useCampusWallet();
  const [controller, setController] = useState<PaymentController | null>(null);
  const [payment, setPayment] = useState<PaymentSnapshot | null>(null);
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
      session = new PaymentController({ preview, account: wallet.address, storage: window.localStorage, wallet: walletController,
        preflight: (payload, account, signal) => verifyInvoicePreview(payload, account, config, rpc, signal),
        exclusive: async (key, run) => { await navigator.locks.request(key, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) throw Error("PAYMENT_LOCKED");
          await run();
        }); } });
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
  const locked = !wallet.canProceed || wallet.chainId !== BigInt(20261);
  return <section className="invoice-payment-panel" aria-labelledby={`${id}-title`} aria-busy={payment?.busy}>
    <h4 id={`${id}-title`}>Thanh toán bằng ví sinh viên</h4>
    <p>Core sẽ yêu cầu xác nhận giao dịch tới payment registry. Gas được tính riêng.</p>
    <p>Ví trả: <code className="wallet-address">{wallet.address}</code></p>
    <p>Người nhận CAMPUS: <code className="wallet-address">{preview.envelope.invoice.merchant}</code></p>
    <p><strong>Số tiền cần xác nhận: {formatWalletBalance(quote.paidAmount)}</strong></p>
    {payment?.status === "quote-changed" ? <dl className="price-breakdown">
      <div className="price-row"><dt>Giá gốc mới kiểm tra</dt><dd>{formatWalletBalance(quote.originalAmount)}</dd></div>
      <div className="price-row"><dt>Ưu đãi hiện tại</dt><dd>{formatWalletBalance(quote.discountAmount)}</dd></div>
    </dl> : null}
    {setupError ? <p className="wallet-warning" role="alert">{setupError}</p> : null}
    {payment?.message ? <p className="wallet-status" role="status">{payment.message}</p> : null}
    {payment?.txHash ? <><p>Tx hash</p><code className="tx-hash-code">{payment.txHash}</code>
      <CopyButton label="Sao chép hash thanh toán" value={payment.txHash} /></> : null}
    {payment?.status === "unknown" && !payment.txHash ? <div>
      <label htmlFor={`${id}-hash`}>Hash từ lịch sử Core (nếu đã gửi)</label>
      <input id={`${id}-hash`} className="invoice-payload" value={manualHash} onChange={(event) => setManualHash(event.target.value)} />
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
  useEffect(() => {
    setPreview(null); setError(false);
    if (!wallet.address) return;
    try { setPreview(restorePaymentPreview(window.localStorage, wallet.address)); }
    catch { setError(true); }
  }, [wallet.address]);
  return error ? <p className="wallet-warning" role="alert">Không đọc được lần thanh toán đã lưu. Giữ invoiceId/hash từ Core và đối chiếu trên POS trước khi ký thêm.</p>
    : preview ? <section className="surface-panel" aria-label="Khôi phục thanh toán">
      <h3>Lần thanh toán đã lưu</h3>
      <p>invoiceId: <code className="tx-hash-code">{preview.envelope.invoice.invoiceId}</code></p>
      <PayInvoice preview={preview} />
    </section> : null;
}
