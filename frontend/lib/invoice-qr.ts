import QRCode from "qrcode";

export type InvoiceQrImage = { src: string; displayWidth: number };

export async function renderInvoiceQr(payload: string): Promise<InvoiceQrImage> {
  const errorCorrectionLevel = "Q";
  const margin = 4;
  const side = QRCode.create(payload, { errorCorrectionLevel }).modules.size + margin * 2;
  // Keep each module aligned to whole pixels at the usual 320px POS width.
  const displayWidth = side * Math.max(1, Math.floor(320 / side));
  const src = await QRCode.toDataURL(payload, { errorCorrectionLevel, margin, scale: 4 });
  return { src, displayWidth };
}
