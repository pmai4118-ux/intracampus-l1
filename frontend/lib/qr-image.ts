export function pastedQrImage(clipboard: DataTransfer): File | undefined {
  return Array.from(clipboard.files).find((file) => file.type.startsWith("image/"));
}

export async function createQrFrameReader(maxDimension: number) {
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Image canvas unavailable");
  return (source: CanvasImageSource, width: number, height: number) => {
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const frameWidth = Math.max(1, Math.round(width * scale));
    const frameHeight = Math.max(1, Math.round(height * scale));
    if (canvas.width !== frameWidth) canvas.width = frameWidth;
    if (canvas.height !== frameHeight) canvas.height = frameHeight;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, frameWidth, frameHeight);
    context.drawImage(source, 0, 0, frameWidth, frameHeight);
    const frame = context.getImageData(0, 0, frameWidth, frameHeight);
    return { frame, payload: jsQR(frame.data, frameWidth, frameHeight)?.data ?? null };
  };
}

export async function decodeQrImage(file: Blob): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const read = await createQrFrameReader(4096);
    const { payload, frame } = read(image, image.naturalWidth, image.naturalHeight);
    if (payload) return payload;

    const { decodeQrImageFallback } = await import("./qr-image-fallback");
    return decodeQrImageFallback(frame);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function readQrClipboard(): Promise<string | Blob> {
  const clipboard = navigator.clipboard;
  if (clipboard?.read) {
    const items = await clipboard.read().catch(() => []);
    for (const item of items) {
      const type = item.types.find((format) => format.startsWith("image/"));
      if (type) return item.getType(type);
    }
    for (const item of items) {
      if (item.types.includes("text/plain")) return (await item.getType("text/plain")).text();
    }
  }
  return clipboard.readText();
}
