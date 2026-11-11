export const campusNetwork = {
  name: "IntraCampus L1",
  chainId: 20261,
  nativeCurrency: { name: "Campus", symbol: "CAMPUS", decimals: 18 },
} as const;

export type { SignedInvoiceEnvelope, InvoiceTransaction, VerifiedInvoiceReceipt, InvoiceApiError, InvoiceLookupResponse } from "./invoices.ts";

export type NetworkProbe = {
  expectedChainId: number;
} & (
  | { status: "ready" | "wrong-chain"; chainId: number }
  | { status: "not-configured" | "unreachable" }
);
