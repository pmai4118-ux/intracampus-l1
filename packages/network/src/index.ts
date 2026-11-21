export { selectedDeploymentManifest } from "./deployment-profile.ts";
export { CAMPUS_CHAIN_ID, CLOUD_CAMPUS_CHAIN_ID, LOCAL_CAMPUS_CHAIN_ID, campusNetwork, resolveCampusChainId, type CampusChainId } from "./chain.ts";
export { getDeployment, requireDeployment, deploymentResponse } from "./deployment.ts";
export { getLibraryDeployment, requireLibraryDeployment, libraryEscrowSupportsRoleUpdates } from "./library-deployment.ts";
export type {
  DeployedLibraryDeployment,
  LibraryBookTerms,
  LibraryDeployedManifest,
  LibraryDeployment,
  LibraryDeploymentEnvironment,
  LibraryDeploymentPolicy,
  LibrarySeedTransaction,
  UnconfiguredLibraryDeployment,
} from "./library-deployment.ts";
export type { DeployedManifest, PublicContract } from "./deployment.ts";

export type { SignedInvoiceEnvelope, InvoiceTransaction, VerifiedInvoiceReceipt, InvoiceApiError, InvoiceLookupResponse } from "./invoices.ts";
export { isParkingInvoice, type OpenParkingTicket, type ParkingCheckout } from "./invoices.ts";
export { LIBRARY_REQUEST_BODY_LIMIT_BYTES } from "./library.ts";

export type NetworkProbe = {
  expectedChainId: number;
} & (
  | { status: "ready" | "wrong-chain"; chainId: number; latestBlock: { number: number; timestamp: number }; headAgeSeconds: number }
  | { status: "not-configured" | "unreachable" }
);

export type {
  CampusAuthRole,
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
  LibraryUnmatchedDeposit,
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

export type { CanteenDish, CanteenItem, CanteenOrder } from './canteen.ts';
export * from "./campus.ts";
export * from "./admin.ts";
