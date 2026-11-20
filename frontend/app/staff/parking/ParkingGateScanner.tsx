"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import { scannedParkingCheckoutPath } from "../../../lib/parking";
import { createQrFrameReader, decodeQrImage, pastedQrImage } from "../../../lib/qr-image";

export default function ParkingGateScanner() {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);

  const openTicket = useCallback((code: string) => {
    const path = scannedParkingCheckoutPath(code, window.location.origin);
    if (path) {
      router.push(path);
      return true;
    }
    setError("Dùng QR ra bãi xe trong Ví sinh viên trên cùng địa chỉ IntraCampus với trang Cổng ra.");
    return false;
  }, [router]);

  useEffect(() => {
    if (!cameraOpen) return;
    const video = videoRef.current;
    if (!video || !navigator.mediaDevices?.getUserMedia) {
      setError("Trình duyệt chưa truy cập được camera. Hãy chọn hoặc dán ảnh QR.");
      setCameraOpen(false);
      return;
    }
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRead: string | null = null;

    async function startCamera(preview: HTMLVideoElement) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 960 } },
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        preview.srcObject = stream;
        await preview.play();
        const read = await createQrFrameReader(960);
        if (stopped) return;
        setCameraReady(true);

        function scan() {
          if (stopped) return;
          try {
            if (preview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              const { payload: code } = read(preview, preview.videoWidth, preview.videoHeight);
              if (code && code !== lastRead && openTicket(code)) {
                setCameraOpen(false);
                return;
              }
              lastRead = code;
            }
          } catch {
            setError("Không đọc được hình từ camera. Hãy mở lại camera hoặc chọn ảnh QR.");
            setCameraOpen(false);
            return;
          }
          timer = setTimeout(scan, 200);
        }
        scan();
      } catch {
        if (stopped) return;
        setError("Không mở được camera. Kiểm tra quyền camera hoặc chọn ảnh QR.");
        setCameraOpen(false);
      }
    }
    void startCamera(video);
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    };
  }, [cameraOpen, openTicket]);

  async function openImage(file: File) {
    if (busy) return;
    setCameraOpen(false);
    setBusy(true);
    setError("");
    try {
      const code = await decodeQrImage(file);
      if (code) openTicket(code);
      else setError("Không tìm thấy QR trong ảnh. Hãy chụp rõ và đủ bốn góc mã.");
    } catch {
      setError("Không đọc được ảnh QR. Hãy thử ảnh PNG hoặc JPEG.");
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

  return <form className="surface-panel parking-gate-input" onSubmit={(event) => {
    event.preventDefault();
    if (!busy && value.trim() && openTicket(value)) setCameraOpen(false);
  }}>
    <h2>Mở vé từ QR</h2>
    <p>Quét mã sinh viên xuất trình bằng camera của máy ở cổng ra. Bạn cũng có thể dán liên kết hoặc ảnh QR.</p>
    <label htmlFor="parking-gate-code">Liên kết hoặc ảnh QR ra</label>
    <input id="parking-gate-code" className="invoice-payload" value={value} readOnly={busy} onPaste={pasteQr}
      onChange={(event) => { setValue(event.target.value); setError(""); }} autoComplete="off" spellCheck={false}
      aria-invalid={Boolean(error)} aria-describedby={error ? "parking-gate-error" : undefined} />
    <input ref={fileInput} type="file" accept="image/*" hidden onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) void openImage(file);
    }} />
    <div className="inline-actions">
      <button type="submit" className="primary-cta-btn" disabled={busy || !value.trim()}>Mở vé</button>
      <button type="button" className="secondary-btn" disabled={busy} aria-expanded={cameraOpen} aria-controls="parking-gate-camera"
        onClick={() => {
          setError("");
          setCameraReady(false);
          setCameraOpen(!cameraOpen);
        }}>{cameraOpen ? "Đóng camera" : "Quét bằng camera"}</button>
      <button type="button" className="secondary-btn" disabled={busy} onClick={() => fileInput.current?.click()}>Chọn ảnh QR</button>
    </div>
    <div id="parking-gate-camera" hidden={!cameraOpen}>
      {cameraOpen ? <div className="invoice-camera-panel">
        <video ref={videoRef} playsInline muted aria-label="Khung camera để quét vé ra" />
        <p role="status">{cameraReady ? "Đưa QR ra bãi xe vào khung hình." : "Đang mở camera…"}</p>
      </div> : null}
    </div>
    {busy ? <p role="status">Đang đọc QR…</p> : null}
    {error ? <p role="alert" id="parking-gate-error" className="wallet-warning">{error}</p> : null}
  </form>;
}
