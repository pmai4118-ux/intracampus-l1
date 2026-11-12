import type { SignedInvoiceEnvelope } from "@intracampus/network";
import { campusNetwork, isWalletAddress } from "./chains.ts";
import type { WalletRpc } from "./wallet.ts";

const MAX_UINT256 = BigInt(2) ** BigInt(256) - BigInt(1);
const MAX_UINT64 = BigInt(2) ** BigInt(64) - BigInt(1);
const SECP256K1_HALF_N = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
const DOMAIN_NAME = "IntraCampusPayment";
const DOMAIN_VERSION = "1";
const UINT_WORD = /^[0-9a-f]{64}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;

export type InvoicePreviewQuote = {
  tier: 0 | 1;
  originalAmount: bigint;
  discountAmount: bigint;
  paidAmount: bigint;
  blockNumber: string;
  blockTimestamp: bigint;
};

export class InvoicePreviewError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "InvoicePreviewError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== [...expected].sort()[index])) {
    throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  }
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) throw new InvoicePreviewError("RPC_UNAVAILABLE");
  return BigInt(value);
}

function rpcRecord(value: unknown): Record<string, unknown> {
  try { return record(value); }
  catch { throw new InvoicePreviewError("RPC_UNAVAILABLE"); }
}

function word(value: string) {
  if (!UINT_WORD.test(value)) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  return value.toLowerCase();
}

function addressWord(value: string) {
  if (!isWalletAddress(value)) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function uintWord(value: bigint) {
  if (value < BigInt(0) || value > MAX_UINT256) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  return value.toString(16).padStart(64, "0");
}

function envelopeFingerprint(envelope: SignedInvoiceEnvelope): string {
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    domain: { name: envelope.domain.name, version: envelope.domain.version, chainId: envelope.domain.chainId,
      verifyingContract: envelope.domain.verifyingContract.toLowerCase() },
    invoice: { invoiceId: envelope.invoice.invoiceId.toLowerCase(), merchant: envelope.invoice.merchant.toLowerCase(),
      category: envelope.invoice.category.toLowerCase(), amount: envelope.invoice.amount, expiresAt: envelope.invoice.expiresAt },
    meta: { invoiceCode: envelope.meta.invoiceCode, merchantId: envelope.meta.merchantId, merchantName: envelope.meta.merchantName,
      serviceId: envelope.meta.serviceId, serviceName: envelope.meta.serviceName, categoryCode: envelope.meta.categoryCode,
      issuedAt: envelope.meta.issuedAt },
    signer: envelope.signer.toLowerCase(), signature: envelope.signature.toLowerCase(),
  });
}

export function sameInvoiceEnvelope(left: SignedInvoiceEnvelope, right: SignedInvoiceEnvelope) {
  return envelopeFingerprint(left) === envelopeFingerprint(right);
}

export function parseInvoicePayload(payload: string): SignedInvoiceEnvelope {
  if (payload.length === 0 || new TextEncoder().encode(payload).length > 16_384) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  let parsed: unknown;
  try { parsed = JSON.parse(payload); }
  catch { throw new InvoicePreviewError("INVALID_QR_PAYLOAD"); }
  const envelope = record(parsed);
  exactKeys(envelope, ["schemaVersion", "domain", "invoice", "meta", "signer", "signature"]);
  if (envelope.schemaVersion !== 1) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  const domain = record(envelope.domain);
  exactKeys(domain, ["name", "version", "chainId", "verifyingContract"]);
  if (domain.name !== DOMAIN_NAME || domain.version !== DOMAIN_VERSION || domain.chainId !== campusNetwork.chainId
    || !isWalletAddress(domain.verifyingContract)) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  const invoice = record(envelope.invoice);
  exactKeys(invoice, ["invoiceId", "merchant", "category", "amount", "expiresAt"]);
  if (!validHash(invoice.invoiceId) || !isWalletAddress(invoice.merchant) || !validHash(invoice.category)
    || typeof invoice.amount !== "string" || !/^[1-9][0-9]{0,77}$/.test(invoice.amount)) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  const amount = BigInt(invoice.amount);
  if (amount > MAX_UINT256 || !Number.isSafeInteger(invoice.expiresAt) || Number(invoice.expiresAt) < 0
    || BigInt(Number(invoice.expiresAt)) > MAX_UINT64) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  const meta = record(envelope.meta);
  exactKeys(meta, ["invoiceCode", "merchantId", "merchantName", "serviceId", "serviceName", "categoryCode", "issuedAt"]);
  for (const field of ["invoiceCode", "merchantId", "merchantName", "serviceId", "serviceName", "categoryCode"] as const) {
    if (typeof meta[field] !== "string" || !meta[field] || meta[field].length > 160) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  }
  if (!Number.isSafeInteger(meta.issuedAt) || Number(meta.issuedAt) < 0 || !isWalletAddress(envelope.signer)
    || typeof envelope.signature !== "string" || !SIGNATURE.test(envelope.signature)) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  const signatureBytes = envelope.signature.slice(2);
  const s = BigInt(`0x${signatureBytes.slice(64, 128)}`);
  const v = Number.parseInt(signatureBytes.slice(128, 130), 16);
  if (s === BigInt(0) || s > SECP256K1_HALF_N || (v !== 27 && v !== 28)) throw new InvoicePreviewError("INVALID_SIGNATURE");
  return envelope as unknown as SignedInvoiceEnvelope;
}

function encodeInvoiceTuple(envelope: SignedInvoiceEnvelope) {
  const invoice = envelope.invoice;
  return [word(invoice.invoiceId.slice(2)), addressWord(invoice.merchant), word(invoice.category.slice(2)),
    uintWord(BigInt(invoice.amount)), uintWord(BigInt(invoice.expiresAt))].join("");
}

export function encodeInvoiceQuoteCall(envelope: SignedInvoiceEnvelope, payer: string) {
  return `0x7ef51164${encodeInvoiceTuple(envelope)}${addressWord(payer)}`;
}

export function encodeInvoicePaidCall(invoiceId: string) {
  return `0xdb5111ce${word(invoiceId.slice(2))}`;
}

export function encodePosSignerCall() {
  return "0xf06da054";
}

export function encodePayInvoiceSimulation(envelope: SignedInvoiceEnvelope) {
  const signature = envelope.signature.slice(2).toLowerCase();
  if (!SIGNATURE.test(envelope.signature)) throw new InvoicePreviewError("INVALID_SIGNATURE");
  const signatureHex = `${signature}${"0".repeat((64 - (signature.length % 64)) % 64)}`;
  return `0xba5e2a9e${encodeInvoiceTuple(envelope)}${uintWord(BigInt(192))}${uintWord(BigInt(signature.length / 2))}${signatureHex}`;
}

export async function verifyInvoicePreview(
  payload: string,
  payer: string,
  trustedDeployment: { paymentRegistryAddress?: string; posSignerAddress?: string },
  rpc: WalletRpc,
  signal?: AbortSignal,
): Promise<{ envelope: SignedInvoiceEnvelope; quote: InvoicePreviewQuote }> {
  const envelope = parseInvoicePayload(payload);
  if (!isWalletAddress(payer)) throw new InvoicePreviewError("WALLET_REQUIRED");
  if (!isWalletAddress(trustedDeployment.paymentRegistryAddress) || !isWalletAddress(trustedDeployment.posSignerAddress)) {
    throw new InvoicePreviewError("DEPLOYMENT_NOT_CONFIGURED");
  }
  if (envelope.domain.verifyingContract.toLowerCase() !== trustedDeployment.paymentRegistryAddress.toLowerCase()) {
    throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  }

  let lookup: Record<string, unknown>;
  try {
    const response = await fetch(`/api/invoices/${encodeURIComponent(envelope.invoice.invoiceId)}`, {
      cache: "no-store", headers: { accept: "application/json" }, signal,
    });
    if (response.status === 503) throw new InvoicePreviewError("RPC_UNAVAILABLE");
    if (!response.ok) throw new InvoicePreviewError(response.status === 404 ? "INVOICE_NOT_FOUND" : "API_UNAVAILABLE");
    lookup = rpcRecord(await response.json());
  } catch (error) {
    if (error instanceof InvoicePreviewError) throw error;
    throw new InvoicePreviewError("API_UNAVAILABLE");
  }
  if (lookup.invoiceId !== envelope.invoice.invoiceId || typeof lookup.status !== "string" || !lookup.envelope) {
    throw new InvoicePreviewError("INVOICE_NOT_FOUND");
  }
  const stored = parseInvoicePayload(JSON.stringify(lookup.envelope));
  if (envelopeFingerprint(envelope) !== envelopeFingerprint(stored)) throw new InvoicePreviewError("INVALID_QR_PAYLOAD");
  if (lookup.status === "paid") throw new InvoicePreviewError("INVOICE_ALREADY_PAID");
  if (lookup.status === "expired") throw new InvoicePreviewError("INVOICE_EXPIRED");
  if (lookup.status !== "pending") throw new InvoicePreviewError("API_UNAVAILABLE");

  try {
    if (quantity(await rpc("eth_chainId", [], signal)) !== BigInt(campusNetwork.chainId)) throw new InvoicePreviewError("WRONG_CHAIN");
    const block = rpcRecord(await rpc("eth_getBlockByNumber", ["latest", false], signal));
    if (typeof block.number !== "string" || typeof block.timestamp !== "string") throw new InvoicePreviewError("RPC_UNAVAILABLE");
    const blockNumber = quantity(block.number);
    const blockTimestamp = quantity(block.timestamp);
    const blockTag = block.number;
    if (blockTimestamp > BigInt(envelope.invoice.expiresAt)) throw new InvoicePreviewError("INVOICE_EXPIRED");
    const verifier = trustedDeployment.paymentRegistryAddress;
    const call = (data: string) => rpc("eth_call", [{ to: verifier, data }, blockTag], signal);
    const [signerResult, paidResult] = await Promise.all([
      call(encodePosSignerCall()),
      call(encodeInvoicePaidCall(envelope.invoice.invoiceId)),
    ]);
    if (typeof signerResult !== "string" || !/^0x[0-9a-f]{64}$/i.test(signerResult)
      || typeof paidResult !== "string" || !/^0x[0-9a-f]{64}$/i.test(paidResult)) throw new InvoicePreviewError("RPC_UNAVAILABLE");
    const signer = `0x${signerResult.slice(-40)}`;
    if (signer.toLowerCase() !== trustedDeployment.posSignerAddress.toLowerCase()
      || signer.toLowerCase() !== envelope.signer.toLowerCase()) throw new InvoicePreviewError("INVALID_SIGNATURE");
    const paidWord = BigInt(paidResult);
    if (paidWord !== BigInt(0) && paidWord !== BigInt(1)) throw new InvoicePreviewError("RPC_UNAVAILABLE");
    if (paidWord === BigInt(1)) throw new InvoicePreviewError("INVOICE_ALREADY_PAID");

    const quoteResult = await call(encodeInvoiceQuoteCall(envelope, payer));
    if (typeof quoteResult !== "string" || !/^0x[0-9a-f]{192}$/i.test(quoteResult)) throw new InvoicePreviewError("RPC_UNAVAILABLE");
    const tierValue = BigInt(`0x${quoteResult.slice(2, 66)}`);
    const discountAmount = BigInt(`0x${quoteResult.slice(66, 130)}`);
    const paidAmount = BigInt(`0x${quoteResult.slice(130, 194)}`);
    if (tierValue !== BigInt(0) && tierValue !== BigInt(1)) throw new InvoicePreviewError("RPC_UNAVAILABLE");
    const amount = BigInt(envelope.invoice.amount);
    const expectedDiscount = tierValue === BigInt(1) ? amount / BigInt(10) : BigInt(0);
    if (discountAmount !== expectedDiscount || paidAmount !== amount - expectedDiscount) throw new InvoicePreviewError("RPC_UNAVAILABLE");

    const transaction = {
      from: payer,
      to: verifier,
      value: `0x${paidAmount.toString(16)}`,
      data: encodePayInvoiceSimulation(envelope),
    };
    try { await rpc("eth_call", [transaction, blockTag], signal); }
    catch {
      try {
        if (quantity(await rpc("eth_chainId", [], signal)) !== BigInt(campusNetwork.chainId)) throw new InvoicePreviewError("WRONG_CHAIN");
      } catch (error) {
        if (error instanceof InvoicePreviewError) throw error;
        throw new InvoicePreviewError("RPC_UNAVAILABLE");
      }
      throw new InvoicePreviewError("PAYMENT_SIMULATION_FAILED");
    }
    return { envelope: stored, quote: { tier: Number(tierValue) as 0 | 1, originalAmount: amount, discountAmount, paidAmount,
      blockNumber: block.number, blockTimestamp } };
  } catch (error) {
    if (error instanceof InvoicePreviewError) throw error;
    throw new InvoicePreviewError("RPC_UNAVAILABLE");
  }
}
