"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { scannedParkingCheckoutPath } from "../../../lib/parking";
import { cameraErrorMessage, startQrCameraScanner, type CameraFacingMode } from "../../../lib/qr-camera";
import { decodeQrImage, pastedQrImage, readQrClipboard } from "../../../lib/qr-image";
import Icon from "../../components/Icon";

export default function ParkingGateScanner() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [facingMode, setFacingMode] = useState<CameraFacingMode>("environment");
  const [dragActive, setDragActive] = useState(false);

  const openTicket = useCallback((code: string) => {
    const path = scannedParkingCheckoutPath(code, window.location.origin);
    if (path) {
      setError("");
      setStatusNote("Đã nhận diện vé hợp lệ, đang mở màn hình xác nhận…");
      router.push(path);
      return true;
    }
    setError("Dùng QR ra bãi xe trong Ví sinh viên trên cùng địa chỉ IntraCampus với trang Cổng ra.");
    return false;
  }, [router]);

  useEffect(() => {
    if (!cameraOpen) return;
    const video = videoRef.current;
    if (!video) {
      setError("Chưa khởi tạo được khung hình camera. Hãy thử mở lại camera.");
      setCameraOpen(false);
      return;
    }
    setCameraReady(false);
    return startQrCameraScanner({
      video,
      facingMode,
      onReady: () => setCameraReady(true),
      onDetect: (code) => {
        if (openTicket(code)) {
          setCameraOpen(false);
          return true;
        }
        return false;
      },
      onError: (code) => {
        setError(cameraErrorMessage(code));
        setCameraOpen(false);
      },
    });
  }, [cameraOpen, facingMode, openTicket]);

  async function openImage(file: Blob) {
    if (busy) return;
    setCameraOpen(false);
    setBusy(true);
    setError("");
    setStatusNote("Đang đọc mã QR từ ảnh…");
    try {
      const code = await decodeQrImage(file);
      if (code) {
        if (!openTicket(code)) setStatusNote("");
      } else {
        setStatusNote("");
        setError("Không tìm thấy QR trong ảnh. Hãy chụp rõ và đủ bốn góc mã.");
      }
    } catch {
      setStatusNote("");
      setError("Không đọc được ảnh QR. Hãy thử ảnh PNG hoặc JPEG.");
    } finally {
      setBusy(false);
    }
  }

  async function readClipboard() {
    if (busy) return;
    setCameraOpen(false);
    setBusy(true);
    setError("");
    setStatusNote("Đang đọc clipboard…");
    try {
      const input = await readQrClipboard();
      if (typeof input === "string") {
        const text = input.trim();
        if (!text) {
          setStatusNote("");
          setError("Clipboard chưa có liên kết hoặc ảnh QR.");
          return;
        }
        setValue(text);
        if (!openTicket(text)) setStatusNote("");
        return;
      }
      const code = await decodeQrImage(input);
      if (code) {
        if (!openTicket(code)) setStatusNote("");
      } else {
        setStatusNote("");
        setError("Không tìm thấy QR trong ảnh từ clipboard.");
      }
    } catch {
      setStatusNote("");
      setError("Không đọc được clipboard. Bấm vào ô liên kết rồi nhấn Ctrl+V hoặc dùng Chọn ảnh QR.");
    } finally {
      setBusy(false);
    }
  }

  function pasteQr(event: ClipboardEvent<HTMLInputElement>) {
    const image = pastedQrImage(event.clipboardData);
    if (!image) return;
    event.preventDefault();
    void openImage(image);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith("image/"));
    if (file) void openImage(file);
  }

  return (
    <div className="parking-gate-workspace">
      <form
        className="surface-panel parking-gate-input parking-scanner-card"
        aria-labelledby="parking-scanner-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && value.trim() && openTicket(value)) setCameraOpen(false);
        }}
      >
        <div className="panel-heading-with-icon">
          <span className="panel-icon icon-blue">
            <Icon name="qr" />
          </span>
          <div>
            <span className="panel-eyebrow">01 · MÁY QUÉT CỔNG RA</span>
            <h2 id="parking-scanner-title">Mở vé từ QR</h2>
          </div>
          <span className={`network-pill ${cameraOpen ? "pill-ok" : ""}`}>
            <span className="status-dot" aria-hidden="true" />
            {cameraOpen ? (cameraReady ? "Camera đang quét" : "Đang mở camera") : "Sẵn sàng quét"}
          </span>
        </div>

        <p className="parking-scanner-desc">
          Quét mã sinh viên xuất trình bằng camera của máy ở cổng ra. Bạn cũng có thể kéo thả, dán hoặc chọn ảnh QR.
        </p>

        <div
          className={`gate-scanner-stage ${cameraOpen ? "is-live" : ""} ${dragActive ? "is-drag-active" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          {cameraOpen ? (
            <div id="parking-gate-camera" className="gate-camera-shell">
              <div className="gate-camera-frame">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  aria-label="Khung camera để quét vé ra"
                />
                <div className="scanner-overlay" aria-hidden="true">
                  <div className="scanner-reticle">
                    <span className="scanner-beam" />
                  </div>
                </div>
                <span className="camera-live-pill" role="status">
                  <span className="mode-status-dot dot-live" aria-hidden="true" />
                  {cameraReady ? "Đưa QR ra bãi xe vào khung hình." : "Đang mở camera…"}
                </span>
              </div>
              <div className="inline-actions gate-camera-controls">
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={busy}
                  onClick={() => setFacingMode((prev) => (prev === "environment" ? "user" : "environment"))}
                >
                  Đổi camera ({facingMode === "environment" ? "Sau" : "Trước"})
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={busy}
                  aria-expanded={cameraOpen}
                  aria-controls="parking-gate-camera"
                  onClick={() => {
                    setCameraOpen(false);
                    setCameraReady(false);
                  }}
                >
                  Đóng camera
                </button>
              </div>
            </div>
          ) : (
            <div className="gate-scanner-idle">
              <span className="gate-scanner-emblem" aria-hidden="true">
                <Icon name="qr" />
              </span>
              <h3>Đưa vé gửi xe trước camera</h3>
              <p>Hỗ trợ quét trực tiếp qua camera sau/trước hoặc tải ảnh chụp mã QR của sinh viên.</p>
              <div className="inline-actions gate-primary-actions">
                <button
                  type="button"
                  className="primary-cta-btn"
                  disabled={busy}
                  aria-expanded={cameraOpen}
                  aria-controls="parking-gate-camera"
                  onClick={() => {
                    setError("");
                    setStatusNote("");
                    setCameraReady(false);
                    setCameraOpen(true);
                  }}
                >
                  <Icon name="qr" />
                  Quét bằng camera
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  Chọn ảnh QR
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={busy}
                  onClick={() => void readClipboard()}
                >
                  Dán từ clipboard
                </button>
              </div>
            </div>
          )}
        </div>

        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void openImage(file);
          }}
        />

        <div className="gate-manual-entry">
          <label htmlFor="parking-gate-code">Liên kết hoặc ảnh QR ra</label>
          <div className="gate-manual-row">
            <input
              id="parking-gate-code"
              className="invoice-payload"
              value={value}
              readOnly={busy}
              onPaste={pasteQr}
              onChange={(event) => {
                setValue(event.target.value);
                setError("");
              }}
              placeholder="Dán liên kết /staff/parking/checkout/0x… hoặc nhấn Ctrl+V ảnh QR"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "parking-gate-error" : undefined}
            />
            <button type="submit" className="secondary-btn gate-open-btn" disabled={busy || !value.trim()}>
              Mở vé
            </button>
          </div>
        </div>

        {busy || statusNote ? (
          <p className="wallet-status" role="status">
            {statusNote || "Đang đọc QR…"}
          </p>
        ) : null}
        {error ? (
          <p role="alert" id="parking-gate-error" className="wallet-warning">
            {error}
          </p>
        ) : null}
      </form>

      <aside className="surface-panel parking-gate-guide" aria-labelledby="parking-guide-title">
        <div className="panel-heading-with-icon">
          <span className="panel-icon">
            <Icon name="shield" />
          </span>
          <div>
            <span className="panel-eyebrow">QUY TRÌNH CỔNG RA</span>
            <h2 id="parking-guide-title">Kiểm soát lượt ra</h2>
          </div>
        </div>

        <ol className="gate-steps-list">
          <li>
            <span className="gate-step-num tabular-nums">1</span>
            <div>
              <strong>Sinh viên mở Vé gửi xe</strong>
              <p>Mã QR xuất hiện trong mục <em>Vé gửi xe đang sử dụng</em> ở Ví sinh viên ngay sau khi thanh toán xác minh.</p>
            </div>
          </li>
          <li>
            <span className="gate-step-num tabular-nums">2</span>
            <div>
              <strong>Quét QR hoặc dán ảnh vé</strong>
              <p>Hệ thống tự nhận diện mã vé và đối chiếu biên lai đã thanh toán với backend POS.</p>
            </div>
          </li>
          <li>
            <span className="gate-step-num tabular-nums">3</span>
            <div>
              <strong>Xác nhận cho xe qua cổng</strong>
              <p>Mỗi vé chỉ được đóng <strong>1 lần duy nhất</strong> bằng phiên đăng nhập ví nhân viên, không tốn phí gas.</p>
            </div>
          </li>
        </ol>

        <div className="gate-guide-note">
          <Icon name="shield" />
          <span>Vé chưa thanh toán hoặc đã checkout trước đó sẽ được cảnh báo ngay trên màn hình xác nhận.</span>
        </div>
      </aside>
    </div>
  );
}
