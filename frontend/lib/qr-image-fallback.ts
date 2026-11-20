import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

const reader = new URL("zxing-wasm/reader/zxing_reader.wasm", import.meta.url);
prepareZXingModule({ overrides: { locateFile: () => reader.href } });

export async function decodeQrImageFallback(frame: ImageData): Promise<string | null> {
  const [result] = await readBarcodes(frame, { formats: ["QRCode"], maxNumberOfSymbols: 1, tryHarder: true });
  return result?.text || null;
}
