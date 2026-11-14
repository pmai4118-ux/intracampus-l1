export { campusNetwork } from "./chain.ts";
export { getDeployment, requireDeployment, deploymentResponse } from "./deployment.ts";
export type { DeployedManifest, PublicContract } from "./deployment.ts";

export type { SignedInvoiceEnvelope, InvoiceTransaction, VerifiedInvoiceReceipt, InvoiceApiError, InvoiceLookupResponse } from "./invoices.ts";
export { LIBRARY_REQUEST_BODY_LIMIT_BYTES } from "./library.ts";

export type NetworkProbe = {
  expectedChainId: number;
} & (
  | { status: "ready" | "wrong-chain"; chainId: number }
  | { status: "not-configured" | "unreachable" }
);

export type {
  LibraryRole,
  LibraryRequestStatus,
  LibraryLoanStatus,
  LibraryRefundStatus,
  LibraryTransactionAction,
  LibraryTransactionStatus,
  LibraryTransactionSubmission,
  LibraryEscrowState,
  LibraryWei,
  LibraryBytes32,
  LibraryAddress,
  LibraryAccount,
  LibraryAuthChallenge,
  LibrarySession,
  LibraryBook,
  LibraryDepositIntent,
  LibraryTransaction,
  LibraryEventProof,
  CreateLibraryRequest,
  LibraryRequest,
  LibrarySettlement,
  LibrarySettlementPreview,
  LibrarySettlementCondition,
  LibrarySettlementIntentRequest,
  LibrarySettlementIntent,
  LibraryLoan,
  LibraryAccountStatus,
  LibraryApiErrorCode,
  LibraryApiError,
  LibraryApiMeta,
  LibraryRateLimitConfig,
  LibraryRuntimeConfig,
} from "./library.ts";
