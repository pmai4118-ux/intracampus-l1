"use client";
import type { VerifiedInvoiceReceipt } from "@intracampus/network";
import { formatWalletBalance } from "../../lib/chains";
import Icon from "../components/Icon";
import { CopyButton } from "../demo-controls";

/** Receives only the receipt already verified by B02 and structurally checked by the client. */
export function Receipt({ receipt }: { receipt: VerifiedInvoiceReceipt }) {
  const originalAmount = BigInt(receipt.originalAmount);
  const discountAmount = BigInt(receipt.discountAmount);
  const paidAmount = BigInt(receipt.paidAmount);
  const gasFee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  const hasDiscount = discountAmount > BigInt(0);

  return (
    <div className="invoice-verified-preview receipt-ticket">
      <div className="receipt-hero">
        <div className="receipt-hero-top">
          <span className="receipt-hero-icon" aria-hidden="true">
            <Icon name="check" />
          </span>
          <span className="verified-badge">BIÊN NHẬN ĐÃ XÁC MINH</span>
        </div>
        <span className="receipt-hero-label">Số tiền đã thanh toán</span>
        <strong className="receipt-hero-amount tabular-nums">
          {formatWalletBalance(paidAmount)}
        </strong>
        {hasDiscount ? (
          <div className="receipt-hero-savings tabular-nums">
            <s className="receipt-original-strike">
              {formatWalletBalance(originalAmount)}
            </s>
            <span className="receipt-savings-pill">
              Tiết kiệm {formatWalletBalance(discountAmount)}
              {receipt.tier === 1 ? " (-10% SBT)" : ""}
            </span>
          </div>
        ) : null}
      </div>

      <div className="receipt-tear-line" aria-hidden="true" />

      <dl className="price-breakdown tabular-nums">
        <div className="price-row invoice-code-row">
          <dt>Mã hóa đơn</dt>
          <dd>
            <code className="mono-badge invoice-code-badge">{receipt.invoiceCode}</code>
          </dd>
        </div>
        <div className="price-row">
          <dt>Giá gốc</dt>
          <dd>{formatWalletBalance(originalAmount)}</dd>
        </div>
        <div className="price-row discount-row">
          <dt>Ưu đãi (tier {receipt.tier})</dt>
          <dd>
            {hasDiscount ? `-${formatWalletBalance(discountAmount)}` : "0 CAMPUS"}
          </dd>
        </div>
        <div className="price-row total-row">
          <dt>Đã trả</dt>
          <dd className="total-amount">{formatWalletBalance(paidAmount)}</dd>
        </div>
        <div className="price-row gas-row">
          <dt>Gas (riêng)</dt>
          <dd>{formatWalletBalance(gasFee)}</dd>
        </div>
      </dl>

      <details className="receipt-proof-details">
        <summary>Xem bằng chứng on-chain (Block #{receipt.blockNumber})</summary>
        <div className="receipt-proof-body">
          <p>Block / log</p>
          <code className="tx-hash-code">
            #{receipt.blockNumber} / {receipt.logIndex}
          </code>
          <p>Người trả</p>
          <code className="tx-hash-code">{receipt.payer}</code>
          <p>Người nhận</p>
          <code className="tx-hash-code">{receipt.merchant}</code>
          <p>Hợp đồng · chain {receipt.chainId}</p>
          <code className="tx-hash-code">{receipt.contractAddress}</code>
          <p>Tx hash</p>
          <code className="tx-hash-code">{receipt.txHash}</code>
          <CopyButton label="Sao chép tx hash" value={receipt.txHash} />
        </div>
      </details>
    </div>
  );
}
