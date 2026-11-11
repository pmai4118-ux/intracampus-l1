export type SignedInvoiceEnvelope = {
  schemaVersion: 1;
  domain: { name: "IntraCampusPayment"; version: "1"; chainId: 20261; verifyingContract: string };
  invoice: { invoiceId: string; merchant: string; category: string; amount: string; expiresAt: number };
  meta: {
    invoiceCode: string; merchantId: string; merchantName: string;
    serviceId: string; serviceName: string; categoryCode: string; issuedAt: number;
  };
  signer: string;
  signature: string;
};

export type InvoiceTransaction = {
  txHash: string;
  status: "unverified" | "reverted" | "event-mismatch" | "confirmed";
};

export type VerifiedInvoiceReceipt = {
  invoiceId: string; invoiceCode: string; chainId: number; contractAddress: string;
  txHash: string; blockNumber: number; logIndex: number; payer: string; merchant: string;
  category: string; originalAmount: string; discountAmount: string; paidAmount: string;
  tier: 0 | 1; gasUsed: string; effectiveGasPrice: string; verifiedAt: number;
};

export type InvoiceApiError = {
  code: "INVALID_REQUEST" | "INVOICE_NOT_FOUND" | "RPC_UNAVAILABLE" | "WRONG_CHAIN"
    | "TX_REVERTED" | "RECEIPT_EVENT_MISMATCH" | "INTERNAL_ERROR";
  message: string;
  retryable: boolean;
  nextStep: string;
};

type LookupBase = { invoiceId: string; envelope: SignedInvoiceEnvelope };
export type InvoiceLookupResponse = LookupBase & (
  | { status: "paid"; receipt: VerifiedInvoiceReceipt; transaction: InvoiceTransaction & { status: "confirmed" }; updatedAt: number }
  | { status: "pending" | "expired"; receipt: null; transaction: InvoiceTransaction | null; updatedAt: number; error?: InvoiceApiError }
  | { status: "rpc-error"; lastKnownStatus: "pending" | "expired" | null; receipt: null;
      transaction: InvoiceTransaction | null; updatedAt: number | null; error: InvoiceApiError }
);
