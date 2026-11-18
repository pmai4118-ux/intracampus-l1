"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { browserWalletConfig, formatWalletBalance } from "../../lib/chains";
import { InvoicePreviewError, verifyInvoicePreview } from "../../lib/invoice";
import { POS_ACTIVE_PAYLOAD_KEY } from "../../lib/invoice-status";
import { createWalletRpc, type WalletSnapshot } from "../../lib/wallet";
import HashChip from "../components/HashChip";
import { PayInvoice, PaymentRecovery } from "./PayInvoice";

type BarcodeHit = { rawValue: string };
type BarcodeDetectorLike = { detect(source: ImageBitmapSource): Promise<BarcodeHit[]> };
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike;
type CameraWindow = Window & { BarcodeDetector?: BarcodeDetectorConstructor };

const messages: Record<string, string> = {
  INVALID_QR_PAYLOAD: "Payload QR sai định dạng hoặc khác hóa đơn đã được backend phát hành.",
  INVALID_SIGNATURE: "Không xác minh được signer/chữ ký của hóa đơn trên contract.",
  INVOICE_EXPIRED: "Hóa đơn đã hết hạn theo thời gian của chain.",
  INVOICE_ALREADY_PAID: "Hóa đơn này đã được thanh toán. Không mở yêu cầu giao dịch mới.",
  PAYMENT_IN_PROGRESS: "Hóa đơn đang có giao dịch chưa xác minh. Giữ hash cũ và tra cứu trên POS; không thanh toán thêm.",
  WRONG_CHAIN: "RPC đang kết nối sai mạng. Yêu cầu IntraCampus L1 · Chain 20261.",
  STALE_CHAIN_STATE: "Block mới nhất của IntraCampus L1 đã cũ. Kiểm tra node/RPC đang chạy và có block mới, rồi thử lại.",
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
  const [posPayload, setPosPayload] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    const syncPosPayload = () => {
      try {
        const saved = window.localStorage.getItem(POS_ACTIVE_PAYLOAD_KEY);
        setPosPayload(saved && saved.trim() ? saved.trim() : null);
      } catch {
        setPosPayload(null);
      }
    };
    syncPosPayload();
    window.addEventListener("storage", syncPosPayload);
    window.addEventListener("focus", syncPosPayload);
    return () => {
      window.removeEventListener("storage", syncPosPayload);
      window.removeEventListener("focus", syncPosPayload);
    };
  }, []);

  useEffect(() => {
    abort.current?.abort();
    abort.current = null;
    setPreview(null);
    setError(null);
    setBusy(false);
  }, [wallet.address, wallet.chainId]);

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
      if (abort.current === current && !current.signal.aborted) setPreview(result);
    } catch (cause) {
      const code = cause instanceof InvoicePreviewError ? cause.code : "RPC_UNAVAILABLE";
      if (abort.current === current && !current.signal.aborted) setError(messages[code] ?? "Không thể xác minh hóa đơn. Hãy kiểm tra lại mã QR.");
    } finally {
      if (abort.current === current) { abort.current = null; setBusy(false); }
    }
  }

  async function pasteFromClipboard() {
    setCameraStatus(null);
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setPayload(text.trim());
        clearPreview();
        setCameraStatus("Đã dán payload từ clipboard. Bấm kiểm tra để xác minh hóa đơn.");
      } else {
        setCameraStatus("Clipboard đang trống. Hãy sao chép payload từ POS trước.");
      }
    } catch {
      setCameraStatus("Trình duyệt chặn đọc clipboard tự động. Hãy dán thủ công vào ô bên dưới.");
    }
  }

  async function scanQrFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setCameraStatus(null);
    const Detector = (window as CameraWindow).BarcodeDetector;
    if (!Detector || typeof createImageBitmap !== "function") {
      setCameraStatus("Trình duyệt này chưa hỗ trợ giải mã ảnh QR trực tiếp. Hãy dùng nút lấy từ POS hoặc dán payload.");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const hits = await new Detector({ formats: ["qr_code"] }).detect(bitmap);
        if (hits[0]?.rawValue) {
          setPayload(hits[0].rawValue);
          clearPreview();
          setCameraStatus("Đã đọc mã QR từ ảnh. Bấm kiểm tra để xác minh hóa đơn và giá.");
        } else {
          setCameraStatus("Không tìm thấy mã QR trong ảnh đã chọn.");
        }
      } finally {
        bitmap.close?.();
      }
    } catch {
      setCameraStatus("Không đọc được ảnh QR. Hãy thử ảnh rõ nét hơn hoặc dán payload.");
    }
  }

  return <div className="invoice-student-preview" aria-labelledby="invoice-preview-title" aria-busy={busy}>
    <PaymentRecovery />
    <h3 id="invoice-preview-title">Quét hoặc dán hóa đơn POS</h3>
    <p>Đối chiếu hóa đơn với backend và chain 20261, sau đó kiểm tra số tiền trước khi mở Core xác nhận.</p>
    <div className="qr-source-header">
      <label htmlFor="student-invoice-payload">Payload QR</label>
      <div className="qr-paste-actions">
        {posPayload ? <button type="button" className="text-action-btn pos-bridge-btn" disabled={busy} onClick={() => {
          setPayload(posPayload);
          clearPreview();
          setCameraStatus("Đã lấy hóa đơn đang mở từ tab POS trên trình duyệt này.");
        }}>
          Dùng hóa đơn POS đang mở
        </button> : null}
        <button type="button" className="text-action-btn" disabled={busy} onClick={() => void pasteFromClipboard()}>
          Dán từ clipboard
        </button>
        <button type="button" className="text-action-btn" disabled={busy} onClick={() => fileInput.current?.click()}>
          Chọn ảnh QR
        </button>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void scanQrFile(e)} />
        {payload ? <button type="button" className="text-action-btn" disabled={busy} onClick={() => { setPayload(""); clearPreview(); setCameraStatus(null); }}>
          Xóa
        </button> : null}
      </div>
    </div>
    <textarea id="student-invoice-payload" className="invoice-payload" value={payload} rows={4} placeholder="Dán nội dung mã QR từ điểm thu vào đây…"
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
      <span className="verified-badge tabular-nums">ĐÃ XÁC MINH · Chain 20261 · block {BigInt(preview.quote.blockNumber).toString()}</span>
      <h4>{preview.envelope.meta.serviceName}</h4>
      <p>{preview.envelope.meta.merchantName} · người nhận <HashChip value={preview.envelope.invoice.merchant} copyLabel="Sao chép địa chỉ merchant" /></p>
      <h5>{preview.quote.tier === 1 ? "Đủ điều kiện giảm giá SBT" : "Không áp dụng giảm giá SBT"}</h5>
      <dl className="price-breakdown tabular-nums">
        <div className="price-row"><dt>Giá gốc</dt><dd className="tabular-nums">{formatWalletBalance(preview.quote.originalAmount)}</dd></div>
        <div className="price-row"><dt>Giảm giá</dt><dd className="tabular-nums">{formatWalletBalance(preview.quote.discountAmount)}</dd></div>
        <div className="price-row total-row"><dt>Số CAMPUS cần trả</dt><dd className="total-amount tabular-nums">{formatWalletBalance(preview.quote.paidAmount)}</dd></div>
      </dl>
      <p className="invoice-direction-note">Hạn, paid flag, verifier/signer, giá và mô phỏng sẽ được kiểm tra lại ngay trước khi mở Core xác nhận.</p>
      <PayInvoice preview={preview} />
    </section> : null}
  </div>;
}
