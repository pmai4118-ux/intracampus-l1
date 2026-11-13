"use client";
import type { VerifiedInvoiceReceipt } from "@intracampus/network";
import { formatWalletBalance } from "../../lib/chains";
import { CopyButton } from "../demo-controls";

/** Receives only the receipt already verified by B02 and structurally checked by the client. */
export function Receipt({ receipt }: { receipt: VerifiedInvoiceReceipt }) {
  return <div className="invoice-verified-preview">
    <span className="verified-badge">BIÊN NHẬN ĐÃ XÁC MINH</span>
    <dl className="price-breakdown">
      <div className="price-row"><dt>Mã hóa đơn</dt><dd>{receipt.invoiceCode}</dd></div>
      <div className="price-row"><dt>Giá gốc</dt><dd>{formatWalletBalance(BigInt(receipt.originalAmount))}</dd></div>
      <div className="price-row"><dt>Ưu đãi (tier {receipt.tier})</dt><dd>{formatWalletBalance(BigInt(receipt.discountAmount))}</dd></div>
      <div className="price-row"><dt>Đã trả</dt><dd>{formatWalletBalance(BigInt(receipt.paidAmount))}</dd></div>
      <div className="price-row"><dt>Gas (riêng)</dt><dd>{formatWalletBalance(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice))}</dd></div>
      <div className="price-row"><dt>Block / log</dt><dd>{receipt.blockNumber} / {receipt.logIndex}</dd></div>
    </dl>
    <p>Người trả</p><code className="tx-hash-code">{receipt.payer}</code>
    <p>Người nhận</p><code className="tx-hash-code">{receipt.merchant}</code>
    <p>Hợp đồng · chain {receipt.chainId}</p><code className="tx-hash-code">{receipt.contractAddress}</code>
    <p>Tx hash</p><code className="tx-hash-code">{receipt.txHash}</code>
    <CopyButton label="Sao chép tx hash" value={receipt.txHash} />
  </div>;
}
