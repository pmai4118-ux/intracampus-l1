import { id } from "ethers";
import { campusNetwork, type SignedInvoiceEnvelope } from "@intracampus/network";

export function isHash(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}
export function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
}
export function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) throw new Error("Invalid RPC quantity");
  return BigInt(value);
}
export function safeQuantity(value: unknown): number {
  const result = Number(quantity(value));
  if (!safeInteger(result)) throw new Error("Unsafe RPC quantity");
  return result;
}
export function hex(value: number): string { return `0x${value.toString(16)}`; }
export function same(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// B01 calls this at the internal persistence boundary, never from a public registration endpoint.
export function assertEnvelope(value: unknown): asserts value is SignedInvoiceEnvelope {
  const v = object(value), domain = object(v.domain), invoice = object(v.invoice), meta = object(v.meta);
  if (!exactKeys(v, ["schemaVersion", "domain", "invoice", "meta", "signer", "signature"])
    || !exactKeys(domain, ["name", "version", "chainId", "verifyingContract"])
    || !exactKeys(invoice, ["invoiceId", "merchant", "category", "amount", "expiresAt"])
    || !exactKeys(meta, ["invoiceCode", "merchantId", "merchantName", "serviceId", "serviceName", "categoryCode", "issuedAt"])
    || v.schemaVersion !== 1 || domain.name !== "IntraCampusPayment" || domain.version !== "1"
    || domain.chainId !== campusNetwork.chainId || !isAddress(domain.verifyingContract)
    || !isHash(invoice.invoiceId) || !isHash(invoice.category) || !isAddress(invoice.merchant)
    || typeof invoice.amount !== "string" || !/^[1-9][0-9]{0,77}$/.test(invoice.amount)
    || BigInt(invoice.amount) >= 2n ** 256n || !safeInteger(invoice.expiresAt)
    || !safeInteger(meta.issuedAt) || meta.issuedAt > invoice.expiresAt || !isAddress(v.signer)
    || typeof v.signature !== "string" || !/^0x[0-9a-f]{130}$/i.test(v.signature)) throw new Error("Invalid invoice envelope");
  for (const key of ["invoiceCode", "merchantId", "merchantName", "serviceId", "serviceName", "categoryCode"]) {
    if (typeof meta[key] !== "string" || meta[key].length === 0 || meta[key].length > 256) throw new Error("Invalid invoice metadata");
  }
  if (!same(invoice.invoiceId, id(meta.invoiceCode as string)) || !same(invoice.category, id(meta.categoryCode as string))) {
    throw new Error("Invoice metadata does not match signed identifiers");
  }
}
