import { readFileSync } from "node:fs";
import type { SignedInvoiceEnvelope } from "@intracampus/network";
import type { InvoiceRpc } from "../src/modules/invoices/invoices.rpc.ts";
import { hex } from "../src/modules/invoices/invoices.schema.ts";
import { paymentAbi } from "../src/modules/invoices/receipt.verifier.ts";

export const fixture = JSON.parse(readFileSync(new URL("../../docs/fixtures/invoice-v1.json", import.meta.url), "utf8"));
export const envelope: SignedInvoiceEnvelope = fixture.envelope;
export const invoiceId = envelope.invoice.invoiceId;
export const txHash = `0x${"12".repeat(32)}`;
export const otherHash = `0x${"34".repeat(32)}`;
export const blockHash = `0x${"ab".repeat(32)}`;
export const deployment = { contractAddress: envelope.domain.verifyingContract, deploymentBlock: 1 };

export function receipt(row = fixture.receiptCases[0]) {
  const event = paymentAbi.encodeEventLog(paymentAbi.getEvent("InvoicePaid")!, [
    invoiceId, fixture.responses.paid.receipt.payer, envelope.invoice.merchant, envelope.invoice.category,
    row.originalAmount, row.discountAmount, row.paidAmount, row.tier,
  ]);
  return { status: "0x1", transactionHash: txHash, blockHash, blockNumber: "0x80",
    gasUsed: "0x10b44", effectiveGasPrice: "0x5d21dba00", logs: [{ ...event,
      address: deployment.contractAddress, transactionHash: txHash, blockHash, blockNumber: "0x80", logIndex: "0x0", removed: false }] };
}

export class FakeRpc implements InvoiceRpc {
  available = true;
  chain = "0x4f25";
  head = 128;
  timestamp = envelope.invoice.expiresAt;
  paid = false;
  logs: unknown[] = [];
  receipts = new Map<string, unknown>();
  blocks = new Map<number, { timestamp: number; hash: string }>();
  calls: { method: string; params: unknown[] }[] = [];
  async call(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    if (!this.available) throw new Error("Simulated RPC outage");
    if (method === "eth_chainId") return this.chain;
    if (method === "eth_getBlockByNumber") {
      const n = params[0] === "latest" ? this.head : Number(BigInt(params[0] as string));
      const b = this.blocks.get(n) ?? { timestamp: this.timestamp, hash: blockHash };
      return { number: hex(n), timestamp: hex(b.timestamp), hash: b.hash };
    }
    if (method === "eth_getLogs") {
      const range = params[0] as { fromBlock: string; toBlock: string };
      return structuredClone(this.logs.filter((value) => {
        const block = BigInt((value as { blockNumber: string }).blockNumber);
        return block >= BigInt(range.fromBlock) && block <= BigInt(range.toBlock);
      }));
    }
    if (method === "eth_call") return `0x${"0".repeat(63)}${this.paid ? "1" : "0"}`;
    if (method === "eth_getTransactionReceipt") return structuredClone(this.receipts.get(params[0] as string) ?? null);
    throw new Error(`Unexpected method ${method}`);
  }
  settle() {
    const r = receipt();
    this.receipts.set(txHash, r); this.logs = r.logs; this.paid = true;
    return r;
  }
}
