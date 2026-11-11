export { campusNetwork } from "./chain.ts";
export { getDeployment, requireDeployment, deploymentResponse } from "./deployment.ts";
export type { DeployedManifest, PublicContract } from "./deployment.ts";

export type { SignedInvoiceEnvelope, InvoiceTransaction, VerifiedInvoiceReceipt, InvoiceApiError, InvoiceLookupResponse } from "./invoices.ts";

export type NetworkProbe = {
  expectedChainId: number;
} & (
  | { status: "ready" | "wrong-chain"; chainId: number }
  | { status: "not-configured" | "unreachable" }
);
