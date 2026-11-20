"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useRouter } from "next/navigation";
import { browserWalletConfig, formatWalletBalance } from "../../lib/chains";
import { InvoicePreviewError, verifyInvoicePreview } from "../../lib/invoice";
import { POS_ACTIVE_PAYLOAD_KEY } from "../../lib/invoice-status";
import { scannedParkingCheckoutPath } from "../../lib/parking";
import { decodeQrImage, pastedQrImage, readQrClipboard } from "../../lib/qr-image";
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
  const router = useRouter();
  const [payload, setPayload] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof verifyInvoicePreview>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [readingQr, setReadingQr] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<string | null>(null);
  const [posPayload, setPosPayload] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const checkoutLink = payload && typeof window !== "undefined"
    ? scannedParkingCheckoutPath(payload, window.location.origin) : null;

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
      setCameraStatus("Trình duyệt này chưa hỗ trợ quét qua camera. Hãy dán ảnh hoặc chọn tệp QR.");
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
          if (!stopped && hits[0]?.rawValue) {
            const checkout = scannedParkingCheckoutPath(hits[0].rawValue, window.location.origin);
            setCameraActive(false);
            if (checkout) { router.push(checkout); return; }
            setPayload(hits[0].rawValue);
            setPreview(null);
            setError(null);
            setCameraStatus("Đã đọc QR. Bấm kiểm tra để xác minh hóa đơn và giá.");
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
  }, [cameraActive, router]);

  const clearPreview = useCallback(() => {
    abort.current?.abort();
    setPreview(null);
    setError(null);
  }, []);

  async function checkInvoice() {
    clearPreview();
    if (checkoutLink) { router.push(checkoutLink); return; }
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

  async function readQrInput(read: () => Promise<Blob | string>) {
    if (busy || readingQr) return;
    setReadingQr(true);
    setCameraActive(false);
    setCameraStatus("Đang đọc mã QR…");
    let input: Blob | string | undefined;
    try {
      input = await read();
      if (typeof input === "string") {
        const text = input.trim();
        if (!text) { setCameraStatus("Clipboard chưa có ảnh hoặc nội dung QR."); return; }
        setPayload(text);
        clearPreview();
        setCameraStatus("Đã dán nội dung QR từ clipboard.");
        return;
      }
      const code = await decodeQrImage(input);
      if (!code) { setCameraStatus("Không tìm thấy mã QR trong ảnh. Hãy thử ảnh rõ hơn, có đủ bốn góc mã."); return; }
      const checkout = scannedParkingCheckoutPath(code, window.location.origin);
      if (checkout) { router.push(checkout); return; }
      setPayload(code);
      clearPreview();
      setCameraStatus("Đã đọc mã QR từ ảnh. Bấm kiểm tra để xác minh hóa đơn và giá.");
    } catch {
      setCameraStatus(input === undefined
        ? "Không đọc được clipboard. Bấm vào ô QR rồi nhấn Ctrl+V hoặc dùng Chọn ảnh QR."
        : "Không đọc được ảnh QR. Hãy thử ảnh PNG hoặc JPEG.");
    } finally {
      setReadingQr(false);
    }
  }

  function pasteQrImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const image = pastedQrImage(event.clipboardData);
    if (!image) return;
    event.preventDefault();
    void readQrInput(async () => image);
  }

  function scanQrFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void readQrInput(async () => file);
  }

  return <div className="invoice-student-preview" aria-labelledby="invoice-preview-title" aria-busy={busy}>
    <PaymentRecovery />
    <h3 id="invoice-preview-title">Quét hoặc dán hóa đơn POS</h3>
    <p>Đối chiếu hóa đơn với backend và chain 20261, sau đó kiểm tra số tiền trước khi mở Core xác nhận.</p>
    <div className="qr-source-header">
      <label htmlFor="student-invoice-payload">Payload QR</label>
      <div className="qr-paste-actions">
        {posPayload ? <button type="button" className="text-action-btn pos-bridge-btn" disabled={busy || readingQr} onClick={() => {
          setPayload(posPayload);
          clearPreview();
          setCameraStatus("Đã lấy hóa đơn đang mở từ tab POS trên trình duyệt này.");
        }}>
          Dùng hóa đơn POS đang mở
        </button> : null}
        <button type="button" className="text-action-btn" disabled={busy || readingQr} onClick={() => void readQrInput(readQrClipboard)}>
          Dán từ clipboard
        </button>
        <button type="button" className="text-action-btn" disabled={busy || readingQr} onClick={() => fileInput.current?.click()}>
          Chọn ảnh QR
        </button>
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={scanQrFile} />
        {payload ? <button type="button" className="text-action-btn" disabled={busy || readingQr} onClick={() => { setPayload(""); clearPreview(); setCameraStatus(null); }}>
          Xóa
        </button> : null}
      </div>
    </div>
    <textarea id="student-invoice-payload" className="invoice-payload" value={payload} rows={4} placeholder="Dán ảnh hoặc nội dung QR từ điểm thu vào đây…"
      aria-describedby={error ? "student-invoice-help student-invoice-error" : "student-invoice-help"} aria-invalid={Boolean(error)}
      readOnly={readingQr} onPaste={pasteQrImage}
      onChange={(event) => { setPayload(event.target.value); clearPreview(); }} />
    <p id="student-invoice-help" className="metric-note">Bạn có thể quét QR thanh toán, dán ảnh hoặc chọn tệp QR do Điểm thu cung cấp.</p>
    <div className="inline-actions invoice-preview-actions">
      <button type="button" className="secondary-btn" disabled={busy || readingQr || cameraActive} onClick={() => { setCameraStatus(null); setCameraActive(true); }}>
        Quét bằng camera
      </button>
      <button type="button" className="primary-cta-btn" disabled={busy || readingQr || !payload.trim() || (!checkoutLink && (!wallet.canProceed || !wallet.address))} onClick={() => void checkInvoice()}>
        {busy ? "Đang xác minh…" : checkoutLink ? "Mở checkout bãi xe" : "Kiểm tra hóa đơn"}
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
