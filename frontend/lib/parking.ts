import type { OpenParkingTicket, ParkingCheckout } from "@intracampus/network";

export const parkingInvoiceId = /^0x[0-9a-f]{64}$/i;

export function parkingCheckoutPath(invoiceId: string) {
  return `/staff/parking/checkout/${invoiceId}`;
}

export function scannedParkingCheckoutPath(value: string, origin: string): string | null {
  try {
    const url = new URL(value.trim());
    const invoiceId = url.pathname.split("/").at(-1) ?? "";
    if (url.origin === origin && !url.username && !url.password && !url.search && !url.hash
      && parkingInvoiceId.test(invoiceId)
      && [parkingCheckoutPath(invoiceId), `/student/parking/checkout/${invoiceId}`].includes(url.pathname)) {
      return parkingCheckoutPath(invoiceId);
    }
  } catch {
    // A payment QR contains JSON, which the payment flow handles separately.
  }
  return null;
}

export class ParkingCheckoutError extends Error {
  constructor(readonly code: string) { super(code); }
}

async function parkingResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new ParkingCheckoutError(typeof data?.error?.code === "string" ? data.error.code : "UNAVAILABLE");
  return data;
}

export async function readOpenParkingTickets(wallet: string, signal: AbortSignal): Promise<OpenParkingTicket[]> {
  const data = await parkingResponse(await fetch("/api/parking/tickets", {
    cache: "no-store", signal, headers: { "X-Campus-Wallet": wallet },
  }));
  if (!Array.isArray(data?.tickets) || !data.tickets.every((ticket: Partial<OpenParkingTicket> | null) =>
    ticket && typeof ticket.invoiceId === "string" && parkingInvoiceId.test(ticket.invoiceId)
    && typeof ticket.invoiceCode === "string" && ticket.invoiceCode.length > 0
    && Number.isSafeInteger(ticket.checkedInAt) && Number(ticket.checkedInAt) > 0
  )) throw new ParkingCheckoutError("UNAVAILABLE");
  return data.tickets;
}

export async function readParkingCheckout(invoiceId: string, options: { confirm?: boolean; signal?: AbortSignal } = {}): Promise<ParkingCheckout> {
  const data = await parkingResponse(await fetch(`/api/parking/${invoiceId}`, {
    method: options.confirm ? "POST" : "GET", cache: "no-store", signal: options.signal,
  }));
  if (typeof data?.invoiceCode !== "string" || !data.invoiceCode
    || (data.checkedOutAt !== null && (!Number.isSafeInteger(data.checkedOutAt) || data.checkedOutAt <= 0))
    || (options.confirm && data.checkedOutAt === null)) throw new ParkingCheckoutError("UNAVAILABLE");
  return { invoiceCode: data.invoiceCode, checkedOutAt: data.checkedOutAt };
}

export function formatCheckoutTime(timestamp: number) {
  return new Date(timestamp * 1000).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}
