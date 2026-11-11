import { Interface } from "ethers";
import { campusNetwork, type SignedInvoiceEnvelope, type VerifiedInvoiceReceipt } from "@intracampus/network";
import { isAddress, isHash, object, quantity, safeQuantity, same } from "./invoices.schema.ts";

export const paymentAbi = new Interface([
  "event InvoicePaid(bytes32 indexed invoiceId,address indexed payer,address indexed merchant,bytes32 category,uint256 originalAmount,uint256 discountAmount,uint256 paidAmount,uint8 tier)",
  "function isInvoicePaid(bytes32 invoiceId) view returns (bool)",
]);
export const invoicePaidTopic = paymentAbi.getEvent("InvoicePaid")!.topicHash;

export function readReceipt(value: unknown, txHash: string): Record<string, unknown> {
  const r = object(value);
  if (!same(r.transactionHash, txHash) || !isHash(r.blockHash) || !Array.isArray(r.logs)
    || (r.status !== "0x0" && r.status !== "0x1")) throw new Error("Malformed receipt");
  safeQuantity(r.blockNumber);
  quantity(r.gasUsed);
  quantity(r.effectiveGasPrice);
  return r;
}

export function verifyReceiptLog(envelope: SignedInvoiceEnvelope, receipt: Record<string, unknown>, value: unknown, verifiedAt: number): VerifiedInvoiceReceipt | null {
  try {
    const log = object(value);
    if (receipt.status !== "0x1" || log.removed === true || !same(log.address, envelope.domain.verifyingContract)
      || !same(log.transactionHash, receipt.transactionHash as string) || !same(log.blockHash, receipt.blockHash as string)
      || safeQuantity(log.blockNumber) !== safeQuantity(receipt.blockNumber)
      || !Array.isArray(log.topics) || log.topics.length !== 4
      || !log.topics.every(isHash) || !same(log.topics[0], invoicePaidTopic)
      || typeof log.data !== "string" || !/^0x[0-9a-f]{320}$/i.test(log.data)) return null;
    // Check address padding and uint8 word ourselves: ABI decoders may tolerate noncanonical encodings.
    for (const i of [2, 3]) if (!/^0x0{24}[0-9a-f]{40}$/i.test(log.topics[i] as string)) return null;
    const tierWord = BigInt(`0x${log.data.slice(-64)}`);
    if (tierWord !== 0n && tierWord !== 1n) return null;
    const decoded = paymentAbi.parseLog({ topics: log.topics as string[], data: log.data });
    if (!decoded) return null;
    const a = decoded.args;
    const original = BigInt(envelope.invoice.amount);
    const discount = tierWord === 1n ? original / 10n : 0n;
    if (!same(a.invoiceId, envelope.invoice.invoiceId) || !same(a.merchant, envelope.invoice.merchant)
      || !isAddress(a.payer) || !same(a.category, envelope.invoice.category)
      || a.originalAmount !== original || a.discountAmount !== discount || a.paidAmount !== original - discount) return null;
    return {
      invoiceId: envelope.invoice.invoiceId, invoiceCode: envelope.meta.invoiceCode,
      chainId: campusNetwork.chainId, contractAddress: envelope.domain.verifyingContract,
      txHash: receipt.transactionHash as string, blockNumber: safeQuantity(receipt.blockNumber), logIndex: safeQuantity(log.logIndex),
      payer: a.payer as string, merchant: a.merchant as string, category: a.category as string,
      originalAmount: original.toString(), discountAmount: discount.toString(), paidAmount: (original - discount).toString(),
      tier: Number(tierWord) as 0 | 1, gasUsed: quantity(receipt.gasUsed).toString(),
      effectiveGasPrice: quantity(receipt.effectiveGasPrice).toString(), verifiedAt,
    };
  } catch { return null; }
}
