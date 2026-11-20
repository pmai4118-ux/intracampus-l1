import { createQrFrameReader } from "./qr-image";

type BarcodeHit = { rawValue?: string };
type BarcodeDetectorLike = { detect(source: ImageBitmapSource): Promise<BarcodeHit[]> };
type BarcodeDetectorConstructor = {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};
type CameraWindow = Window & { BarcodeDetector?: BarcodeDetectorConstructor };

export type CameraFacingMode = "environment" | "user";

export type CameraErrorCode =
  | "INSECURE_CONTEXT"
  | "CAMERA_UNSUPPORTED"
  | "PERMISSION_DENIED"
  | "NO_CAMERA"
  | "CAMERA_BUSY"
  | "CAMERA_ERROR";

export function cameraErrorMessage(code: CameraErrorCode): string {
  switch (code) {
    case "INSECURE_CONTEXT":
      return "Camera yêu cầu kết nối HTTPS (hoặc localhost). Hiện bạn vẫn có thể chọn ảnh hoặc dán QR.";
    case "CAMERA_UNSUPPORTED":
      return "Trình duyệt chưa hỗ trợ truy cập camera. Hãy chọn ảnh hoặc dán QR.";
    case "PERMISSION_DENIED":
      return "Chưa được cấp quyền camera. Hãy cho phép truy cập camera trong trình duyệt, hoặc chọn ảnh / dán QR.";
    case "NO_CAMERA":
      return "Không tìm thấy camera trên thiết bị này. Hãy chọn ảnh hoặc dán QR.";
    case "CAMERA_BUSY":
      return "Camera đang được ứng dụng khác sử dụng. Đóng ứng dụng kia rồi thử lại, hoặc chọn ảnh QR.";
    default:
      return "Không mở được camera. Kiểm tra quyền camera hoặc chọn ảnh QR.";
  }
}

function classifyCameraError(cause: unknown): CameraErrorCode {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "PERMISSION_DENIED";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "NO_CAMERA";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "CAMERA_BUSY";
  }
  return "CAMERA_ERROR";
}

async function createNativeDetector(): Promise<BarcodeDetectorLike | null> {
  const Detector = (window as CameraWindow).BarcodeDetector;
  if (typeof Detector !== "function") return null;
  try {
    if (typeof Detector.getSupportedFormats === "function") {
      const formats = await Detector.getSupportedFormats();
      if (!formats.includes("qr_code")) return null;
    }
    return new Detector({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

async function openCameraStream(facingMode: CameraFacingMode): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
    throw cause;
  }
}

export function startQrCameraScanner({
  video,
  facingMode = "environment",
  onReady,
  onDetect,
  onError,
}: {
  video: HTMLVideoElement;
  facingMode?: CameraFacingMode;
  onReady?: (engine: "native" | "jsqr") => void;
  onDetect: (payload: string) => boolean | void;
  onError: (code: CameraErrorCode) => void;
}): () => void {
  if (typeof window !== "undefined" && !window.isSecureContext && !navigator.mediaDevices?.getUserMedia) {
    onError("INSECURE_CONTEXT");
    return () => {};
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    onError("CAMERA_UNSUPPORTED");
    return () => {};
  }

  let stopped = false;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPayload: string | null = null;

  const cleanup = () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
  };

  void (async () => {
    try {
      const media = await openCameraStream(facingMode);
      if (stopped) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = media;
      video.srcObject = media;
      await video.play();
      if (stopped) {
        cleanup();
        return;
      }

      const nativeDetector = await createNativeDetector();
      if (stopped) return;

      if (nativeDetector) {
        onReady?.("native");
        let nativeErrors = 0;
        const scanNative = async () => {
          if (stopped) return;
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
            try {
              const hits = await nativeDetector.detect(video);
              nativeErrors = 0;
              const code = hits[0]?.rawValue ?? null;
              if (!stopped && code && code !== lastPayload) {
                lastPayload = code;
                if (onDetect(code) !== false) {
                  cleanup();
                  return;
                }
              } else if (!code) {
                lastPayload = null;
              }
            } catch {
              nativeErrors += 1;
              if (nativeErrors >= 3) {
                void startSoftwareScan();
                return;
              }
            }
          }
          if (!stopped) timer = setTimeout(() => void scanNative(), 150);
        };
        timer = setTimeout(() => void scanNative(), 120);
        return;
      }

      await startSoftwareScan();
    } catch (cause) {
      if (stopped) return;
      cleanup();
      onError(classifyCameraError(cause));
    }
  })();

  async function startSoftwareScan() {
    if (stopped) return;
    const readFrame = await createQrFrameReader(960);
    if (stopped) return;
    let fallbackLoader: Promise<((frame: ImageData) => Promise<string | null>) | null> | null = null;
    const loadFallback = () => {
      if (!fallbackLoader) {
        fallbackLoader = import("./qr-image-fallback")
          .then((mod) => mod.decodeQrImageFallback)
          .catch(() => null);
      }
      return fallbackLoader;
    };

    onReady?.("jsqr");
    let missCount = 0;

    const scanFrame = async () => {
      if (stopped) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
        try {
          const { frame, payload } = readFrame(video, video.videoWidth, video.videoHeight);
          let code = payload;
          if (!code) {
            missCount += 1;
            if (missCount % 4 === 0) {
              const decodeFallback = await loadFallback();
              if (!stopped && decodeFallback) {
                code = await decodeFallback(frame).catch(() => null);
              }
            }
          } else {
            missCount = 0;
          }

          if (!stopped && code && code !== lastPayload) {
            lastPayload = code;
            if (onDetect(code) !== false) {
              cleanup();
              return;
            }
          } else if (!code) {
            lastPayload = null;
          }
        } catch {
          // Keep scanning next frame rather than killing camera on a single transient decode glitch.
        }
      }
      if (!stopped) timer = setTimeout(() => void scanFrame(), 180);
    };

    timer = setTimeout(() => void scanFrame(), 120);
  }

  return cleanup;
}
