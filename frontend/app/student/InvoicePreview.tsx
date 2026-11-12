"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { browserWalletConfig, formatWalletBalance } from "../../lib/chains";
import { InvoicePreviewError, verifyInvoicePreview } from "../../lib/invoice";
import { createWalletRpc, type WalletSnapshot } from "../../lib/wallet";

type BarcodeHit = { rawValue: string };
type BarcodeDetectorLike = { detect(source: HTMLVideoElement): Promise<BarcodeHit[]> };
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;
type CameraWindow = Window & { BarcodeDetector?: BarcodeDetectorConstructor };

const messages: Record<string, string> = {
  INVALID_QR_PAYLOAD: "Payload QR sai định dạng hoặc khác hóa đơn đã được backend phát hành.",
  INVALID_SIGNATURE: "Không xác minh được signer/chữ ký của hóa đơn trên contract.",
  INVOICE_EXPIRED: "Hóa đơn đã hết hạn theo thời gian của chain.",
  INVOICE_ALREADY_PAID: "Hóa đơn này đã được thanh toán. Không mở yêu cầu giao dịch mới.",
  WRONG_CHAIN: "RPC đang kết nối sai mạng. Yêu cầu IntraCampus L1 · Chain 20261.",
  DEPLOYMENT_NOT_CONFIGURED: "Chưa có địa chỉ verifier và POS signer từ manifest L06. Chưa thể xác minh hóa đơn.",
  PAYMENT_SIMULATION_FAILED: "Contract chưa chấp nhận thanh toán tại trạng thái hiện tại. Kiểm tra chữ ký hóa đơn, dịch vụ và số dư CAMPUS rồi thử lại.",
  WALLET_REQUIRED: "Hãy kết nối ví Core của người trả tiền trước khi xác minh giá cuối.",
  INVOICE_NOT_FOUND: "Không tìm thấy hóa đơn đã được POS phát hành.",
  API_UNAVAILABLE: "Không đọc được hóa đơn đã lưu từ backend.",
  RPC_UNAVAILABLE: "Không xác minh được trạng thái trên IntraCampus L1. Hãy thử lại sau.",
};

export function InvoicePreview({ wallet }: { wallet: WalletSnapshot }) {
  const [payload, setPayload] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof verifyInvoicePreview>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    abort.current?.abort();
    abort.current = null;
    setPreview(null);
    setError(null);
    setBusy(false);
  }, [wallet.address, wallet.chainId, wallet.canProceed]);

  useEffect(() => {
    if (!cameraActive) return;
    const Detector = (window as CameraWindow).BarcodeDetector;
    if (!Detector) {
      setCameraStatus("Trình duyệt này chưa hỗ trợ quét QR trực tiếp. Hãy dán payload từ POS.");
      setCameraActive(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus("Không truy cập được camera. Hãy dán payload từ POS.");
      setCameraActive(false);
      return;
    }
    let stopped = false;
    let frame = 0;
    let stream: MediaStream | null = null;
    const detector = new Detector({ formats: ["qr_code"] });
    const scan = async () => {
      if (stopped || !video.current) return;
      if (video.current.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          const hits = await detector.detect(video.current);
          if (hits[0]?.rawValue) {
            setPayload(hits[0].rawValue);
            setPreview(null);
            setError(null);
            setCameraStatus("Đã đọc QR. Bấm kiểm tra để xác minh hóa đơn và giá.");
            setCameraActive(false);
            return;
          }
        } catch {
          setCameraStatus("Chưa đọc được mã. Giữ QR trong khung hoặc dán payload.");
        }
      }
      if (!stopped) frame = window.requestAnimationFrame(() => void scan());
    };
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then(async (media) => {
        stream = media;
        if (stopped || !video.current) { media.getTracks().forEach((track) => track.stop()); return; }
        video.current.srcObject = media;
        await video.current.play();
        setCameraStatus("Đưa mã QR của POS vào khung hình.");
        frame = window.requestAnimationFrame(() => void scan());
      })
      .catch(() => {
        setCameraStatus("Không được cấp quyền camera. Bạn vẫn có thể dán payload từ POS.");
        setCameraActive(false);
      });
    return () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current) video.current.srcObject = null;
    };
  }, [cameraActive]);

  const clearPreview = useCallback(() => {
    abort.current?.abort();
    setPreview(null);
    setError(null);
  }, []);

  async function checkInvoice() {
    clearPreview();
    if (!wallet.address || !wallet.canProceed || wallet.chainId !== BigInt(20261)) {
      setError(messages.WALLET_REQUIRED);
      return;
    }
    let rpcUrl: string | undefined;
    try { rpcUrl = browserWalletConfig().rpcUrl; }
    catch { rpcUrl = undefined; }
    if (!rpcUrl) { setError(messages.RPC_UNAVAILABLE); return; }
    const current = new AbortController();
    abort.current = current;
    setBusy(true);
    try {
      const deployment = browserWalletConfig();
      const result = await verifyInvoicePreview(payload, wallet.address, deployment, createWalletRpc(rpcUrl), current.signal);
      setPreview(result);
    } catch (cause) {
      const code = cause instanceof InvoicePreviewError ? cause.code : "RPC_UNAVAILABLE";
      setError(messages[code] ?? "Không thể xác minh hóa đơn. Hãy kiểm tra lại mã QR.");
    } finally {
      if (abort.current === current) { abort.current = null; setBusy(false); }
    }
  }

  return <div className="invoice-student-preview" aria-labelledby="invoice-preview-title" aria-busy={busy}>
    <h3 id="invoice-preview-title">Quét hoặc dán hóa đơn POS</h3>
    <p>Hóa đơn chỉ mở bản xem trước sau khi đối chiếu với backend và chain 20261. Chưa có giao dịch nào được ký hoặc gửi.</p>
    <label htmlFor="student-invoice-payload">Payload QR</label>
    <textarea id="student-invoice-payload" className="invoice-payload" value={payload} rows={5}
      aria-describedby={error ? "student-invoice-help student-invoice-error" : "student-invoice-help"} aria-invalid={Boolean(error)}
      onChange={(event) => { setPayload(event.target.value); clearPreview(); }} />
    <p id="student-invoice-help" className="metric-note">Bạn có thể dùng camera hoặc dán payload đã sao chép từ POS.</p>
    <div className="inline-actions invoice-preview-actions">
      <button type="button" className="secondary-btn" disabled={busy || cameraActive} onClick={() => { setCameraStatus(null); setCameraActive(true); }}>
        Quét bằng camera
      </button>
      <button type="button" className="primary-cta-btn" disabled={busy || !payload.trim() || !wallet.canProceed || !wallet.address} onClick={() => void checkInvoice()}>
        {busy ? "Đang xác minh…" : "Kiểm tra hóa đơn"}
      </button>
    </div>
    {cameraActive ? <div className="invoice-camera-panel">
      <video ref={video} playsInline muted aria-label="Khung camera để quét mã QR" />
      <button type="button" className="secondary-btn" onClick={() => setCameraActive(false)}>Đóng camera</button>
    </div> : null}
    {cameraStatus ? <p className="wallet-status" role="status">{cameraStatus}</p> : null}
    {error ? <p id="student-invoice-error" className="invoice-feedback error-panel" role="alert">{error}</p> : null}
    {preview ? <section className="invoice-verified-preview" aria-live="polite" aria-label="Hóa đơn đã xác minh">
      <span className="verified-badge">ĐÃ XÁC MINH · Chain 20261 · block {BigInt(preview.quote.blockNumber).toString()}</span>
      <h4>{preview.envelope.meta.serviceName}</h4>
      <p>{preview.envelope.meta.merchantName} · người nhận <code>{preview.envelope.invoice.merchant}</code></p>
      <h5>{preview.quote.tier === 1 ? "Đủ điều kiện giảm giá SBT" : "Không áp dụng giảm giá SBT"}</h5>
      <dl className="price-breakdown">
        <div className="price-row"><dt>Giá gốc</dt><dd>{formatWalletBalance(preview.quote.originalAmount)}</dd></div>
        <div className="price-row"><dt>Giảm giá</dt><dd>{formatWalletBalance(preview.quote.discountAmount)}</dd></div>
        <div className="price-row total-row"><dt>Số CAMPUS cần trả</dt><dd className="total-amount">{formatWalletBalance(preview.quote.paidAmount)}</dd></div>
      </dl>
      <p className="invoice-direction-note">Preflight đã kiểm tra hạn, paid flag, verifier/signer, giá và mô phỏng payInvoice. U04 sẽ làm mới kiểm tra ngay trước khi mở Core cho sinh viên xác nhận.</p>
    </section> : null}
  </div>;
}
