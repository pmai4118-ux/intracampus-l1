import assert from "node:assert/strict";
import test from "node:test";
import type { SignedInvoiceEnvelope } from "@intracampus/network";
import { sharedParkingInvoiceEnvelope } from "../app/demo-fixtures.ts";
import { campusNetwork } from "../lib/chains.ts";
import {
  encodeInvoicePaidCall,
  encodeInvoiceQuoteCall,
  encodePayInvoiceSimulation,
  encodePosSignerCall,
  InvoicePreviewError,
  parseInvoicePayload,
  sameInvoiceEnvelope,
  verifyInvoicePreview,
} from "../lib/invoice.ts";
import type { WalletRpc } from "../lib/wallet.ts";

const payer = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const word = (value: bigint) => value.toString(16).padStart(64, "0");

function currentEnvelope(): SignedInvoiceEnvelope {
  const { ttlSeconds: _demoOnlyTtl, ...meta } = sharedParkingInvoiceEnvelope.meta;
  return { ...sharedParkingInvoiceEnvelope, invoice: { ...sharedParkingInvoiceEnvelope.invoice,
    expiresAt: Math.floor(Date.now() / 1000) + 600 }, meta } as SignedInvoiceEnvelope;
}
function trustedDeployment(envelope: SignedInvoiceEnvelope) {
  return { paymentRegistryAddress: envelope.domain.verifyingContract, posSignerAddress: envelope.signer };
}

function mockRpc(envelope: ReturnType<typeof currentEnvelope>, options: { paid?: boolean; revertSimulation?: boolean } = {}) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const amount = BigInt(envelope.invoice.amount);
  const quote = `0x${word(BigInt(1))}${word(amount / BigInt(10))}${word(amount - amount / BigInt(10))}`;
  const rpc: WalletRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_chainId") return `0x${campusNetwork.chainId.toString(16)}`;
    if (method === "eth_getBlockByNumber") return { number: "0x22", timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
    if (method === "eth_call") {
      const transaction = params[0] as { from?: string; value?: string; data: string };
      if (transaction.data.startsWith("0xf06da054")) return `0x${"0".repeat(24)}${envelope.signer.slice(2).toLowerCase()}`;
      if (transaction.data.startsWith("0xdb5111ce")) return `0x${word(options.paid ? BigInt(1) : BigInt(0))}`;
      if (transaction.data.startsWith("0x7ef51164")) return quote;
      if (transaction.data.startsWith("0xba5e2a9e")) {
        assert.equal(transaction.from?.toLowerCase(), payer);
        assert.equal(transaction.value, `0x${(amount - amount / BigInt(10)).toString(16)}`);
        if (options.revertSimulation) throw new Error("RPC_UNAVAILABLE");
        return "0x";
      }
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}

test("strictly parses the invoice contract envelope and rejects changed domain/signature", () => {
  const envelope = currentEnvelope();
  assert.equal(parseInvoicePayload(JSON.stringify(envelope)).invoice.invoiceId, envelope.invoice.invoiceId);
  assert.throws(() => parseInvoicePayload(JSON.stringify({ ...envelope, extra: true })), (error: unknown) =>
    error instanceof InvoicePreviewError && error.code === "INVALID_QR_PAYLOAD");
  assert.throws(() => parseInvoicePayload(JSON.stringify({ ...envelope, domain: { ...envelope.domain, chainId: 43113 } })),
    (error: unknown) => error instanceof InvoicePreviewError && error.code === "INVALID_QR_PAYLOAD");
  assert.throws(() => parseInvoicePayload(JSON.stringify({ ...envelope, signature: `${envelope.signature.slice(0, -2)}00` })),
    (error: unknown) => error instanceof InvoicePreviewError && error.code === "INVALID_SIGNATURE");
});

test("encodes the exact P02 registry calls for this invoice and payer", () => {
  const envelope = currentEnvelope();
  assert.equal(encodePosSignerCall(), "0xf06da054");
  assert.equal(encodeInvoicePaidCall(envelope.invoice.invoiceId).slice(0, 10), "0xdb5111ce");
  assert.equal(encodeInvoiceQuoteCall(envelope, payer).slice(0, 10), "0x7ef51164");
  const simulation = encodePayInvoiceSimulation(envelope);
  assert.equal(simulation.slice(0, 10), "0xba5e2a9e");
  assert.equal(simulation.slice(10 + 5 * 64, 10 + 6 * 64), word(BigInt(192)));
  assert.equal(simulation.slice(10 + 6 * 64, 10 + 7 * 64), word(BigInt(65)));
  assert.equal(simulation.length, 10 + (5 + 1 + 1 + 3) * 64);
});

test("verifies trusted backend envelope, current chain quote and payInvoice simulation", async () => {
  const envelope = currentEnvelope();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ invoiceId: envelope.invoice.invoiceId,
    status: "pending", envelope }), { status: 200, headers: { "content-type": "application/json" } });
  const { rpc, calls } = mockRpc(envelope);
  try {
    const result = await verifyInvoicePreview(JSON.stringify(envelope), payer, trustedDeployment(envelope), rpc);
    assert.equal(result.envelope.invoice.invoiceId, envelope.invoice.invoiceId);
    assert.equal(result.quote.tier, 1);
    assert.equal(result.quote.originalAmount, BigInt(envelope.invoice.amount));
    assert.equal(result.quote.paidAmount, BigInt(envelope.invoice.amount) * BigInt(9) / BigInt(10));
    assert.equal(calls.filter((call) => call.method === "eth_call").length, 4);
  } finally { globalThis.fetch = previousFetch; }
});

test("rejects already-paid invoices before simulating a new payment", async () => {
  const envelope = currentEnvelope();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ invoiceId: envelope.invoice.invoiceId,
    status: "pending", envelope }), { status: 200, headers: { "content-type": "application/json" } });
  const { rpc, calls } = mockRpc(envelope, { paid: true });
  try {
    await assert.rejects(verifyInvoicePreview(JSON.stringify(envelope), payer, trustedDeployment(envelope), rpc), (error: unknown) =>
      error instanceof InvoicePreviewError && error.code === "INVOICE_ALREADY_PAID");
    assert.equal(calls.some((call) => (call.params[0] as { data?: string })?.data?.startsWith("0xba5e2a9e")), false);
  } finally { globalThis.fetch = previousFetch; }
});

test("rejects a payload that differs from the backend-stored invoice", async () => {
  const envelope = currentEnvelope();
  const altered = { ...envelope, invoice: { ...envelope.invoice, amount: (BigInt(envelope.invoice.amount) + BigInt(1)).toString() } };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ invoiceId: altered.invoice.invoiceId,
    status: "pending", envelope }), { status: 200, headers: { "content-type": "application/json" } });
  const { rpc, calls } = mockRpc(envelope);
  try {
    await assert.rejects(verifyInvoicePreview(JSON.stringify(altered), payer, trustedDeployment(envelope), rpc), (error: unknown) =>
      error instanceof InvoicePreviewError && error.code === "INVALID_QR_PAYLOAD");
    assert.equal(calls.length, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("does not query a verifier chosen only by the QR payload", async () => {
  const envelope = currentEnvelope();
  const { rpc, calls } = mockRpc(envelope);
  await assert.rejects(verifyInvoicePreview(JSON.stringify(envelope), payer,
    { paymentRegistryAddress: payer, posSignerAddress: envelope.signer }, rpc), (error: unknown) =>
    error instanceof InvoicePreviewError && error.code === "INVALID_QR_PAYLOAD");
  assert.equal(calls.length, 0);
});

test("maps a reverted payInvoice simulation to a blocked signature preflight", async () => {
  const envelope = currentEnvelope();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ invoiceId: envelope.invoice.invoiceId,
    status: "pending", envelope }), { status: 200, headers: { "content-type": "application/json" } });
  const { rpc } = mockRpc(envelope, { revertSimulation: true });
  try {
    await assert.rejects(verifyInvoicePreview(JSON.stringify(envelope), payer, trustedDeployment(envelope), rpc), (error: unknown) =>
      error instanceof InvoicePreviewError && error.code === "PAYMENT_SIMULATION_FAILED");
  } finally { globalThis.fetch = previousFetch; }
});

test("compares normalized envelopes without trusting their property order", () => {
  const envelope = parseInvoicePayload(JSON.stringify(currentEnvelope()));
  const reordered = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
  assert.equal(sameInvoiceEnvelope(envelope, reordered), true);
  assert.equal(sameInvoiceEnvelope(envelope, { ...reordered, signer: payer }), false);
});
