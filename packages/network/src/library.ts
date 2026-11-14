export type LibraryRole = "STUDENT" | "LIBRARIAN";
export const LIBRARY_REQUEST_BODY_LIMIT_BYTES = 8192 as const;
export type LibraryRequestStatus =
  | "AWAITING_DEPOSIT"
  | "PENDING_APPROVAL"
  | "REJECTED_NO_COPY"
  | "REJECTED"
  | "EXPIRED_REFUND_DUE"
  | "APPROVED"
  | "RETURN_REQUESTED"
  | "SETTLEMENT_PENDING"
  | "RETURNED"
  | "LOST_SHORTFALL_DUE"
  | "LOST_SETTLED";
export type LibraryLoanStatus =
  | "ACTIVE"
  | "RETURN_REQUESTED"
  | "SETTLEMENT_PENDING"
  | "RETURNED"
  | "LOST_SHORTFALL_DUE"
  | "LOST_SETTLED";
export type LibraryRefundStatus = "NONE" | "REFUND_DUE" | "REFUNDED";
export type LibraryTransactionAction =
  | "deposit"
  | "approve"
  | "reject"
  | "refund"
  | "return"
  | "settle"
  | "payShortfall";
export type LibraryTransactionStatus = "UNKNOWN" | "SUBMITTED" | "CONFIRMED" | "REVERTED";
export type LibraryEscrowState =
  | "NONE"
  | "DEPOSITED"
  | "ACTIVE"
  | "REFUNDED"
  | "RETURN_SETTLED"
  | "LOST_SHORTFALL_DUE"
  | "LOST_SETTLED";
export type LibraryWei = string;
export type LibraryBytes32 = `0x${string}`;
export type LibraryAddress = `0x${string}`;

export type LibraryAccount = {
  wallet: LibraryAddress;
  role: LibraryRole;
};

export type LibraryAuthChallenge = {
  challengeId: string;
  message: string;
  expiresAt: number;
};

export type LibrarySession = {
  account: LibraryAccount;
  expiresAt: number;
};

export type LibraryBook = {
  bookId: LibraryBytes32;
  title: string;
  author: string;
  isbn: string | null;
  depositWei: LibraryWei;
  replacementPriceWei: LibraryWei;
  copiesTotal: number;
  copiesAvailable: number;
};

export type LibraryDepositIntent = {
  chainId: 20261;
  to: LibraryAddress;
  data: `0x${string}`;
  valueWei: LibraryWei;
  requestId: LibraryBytes32;
  bookId: LibraryBytes32;
};

export type LibraryTransaction = {
  action: LibraryTransactionAction;
  txHash: `0x${string}`;
  status: LibraryTransactionStatus;
  submittedAt: number;
  proof: LibraryEventProof | null;
};

export type LibraryEventProof = {
  chainId: 20261;
  contractAddress: LibraryAddress;
  txHash: `0x${string}`;
  blockNumber: number;
  blockHash: `0x${string}`;
  logIndex: number;
  eventName:
    | "DepositReceived"
    | "LoanApproved"
    | "RequestRejected"
    | "ExpiredRefundClaimed"
    | "ReturnSettled"
    | "LostSettled"
    | "ShortfallPaid";
  requestId: LibraryBytes32;
  borrower: LibraryAddress;
};

export type CreateLibraryRequest = {
  bookId: LibraryBytes32;
  idempotencyKey: string;
};

export type LibraryRequest = {
  requestId: LibraryBytes32;
  bookId: LibraryBytes32;
  status: LibraryRequestStatus;
  refundStatus: LibraryRefundStatus;
  depositWei: LibraryWei | null;
  depositIntent: LibraryDepositIntent | null;
  approvalDeadline: number | null;
  loanId: LibraryBytes32 | null;
  transactions: LibraryTransaction[];
  createdAt: number;
  updatedAt: number;
};

export type LibrarySettlement =
  | {
      outcome: "RETURNED";
      returnedAt: number;
      lateFeeWei: LibraryWei;
      repairFeeWei: LibraryWei;
      overdueForfeitWei: LibraryWei;
      totalRetainedWei: LibraryWei;
      refundWei: LibraryWei;
      maintenanceRequired: boolean;
    }
  | {
      outcome: "LOST";
      replacementPriceWei: LibraryWei;
      totalRetainedWei: LibraryWei;
      refundWei: LibraryWei;
      shortfallWei: LibraryWei;
    };

export type LibrarySettlementPreview = LibrarySettlement;

type LibrarySettlementIntentBase = {
  requestId: LibraryBytes32;
  loanId: LibraryBytes32;
  borrower: LibraryAddress;
  chainId: 20261;
  escrow: LibraryAddress;
  treasury: LibraryAddress;
  walletCall: {
    to: LibraryAddress;
    data: `0x${string}`;
    valueWei: LibraryWei;
  };
  chainTime: number;
};

export type LibrarySettlementIntent =
  | (LibrarySettlementIntentBase & {
      outcome: "RETURNED";
      preview: Extract<LibrarySettlementPreview, { outcome: "RETURNED" }>;
    })
  | (LibrarySettlementIntentBase & {
      outcome: "LOST";
      preview: Extract<LibrarySettlementPreview, { outcome: "LOST" }>;
    });

export type LibraryLoan = {
  loanId: LibraryBytes32;
  requestId: LibraryBytes32;
  bookId: LibraryBytes32;
  borrower: LibraryAddress;
  status: LibraryLoanStatus;
  approvedAt: number;
  dueAt: number;
  returnRequestedAt: number | null;
  settlement: LibrarySettlement | null;
};

export type LibraryAccountStatus = {
  held: boolean;
  checkedAt: number;
  blockingLoanIds: LibraryBytes32[];
};

export type LibraryApiErrorCode =
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RPC_UNAVAILABLE"
  | "WRONG_CHAIN"
  | "STALE_CHAIN_STATE"
  | "DATABASE_BUSY"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

export type LibraryRateLimitConfig = {
  maxRequests: number;
  windowSeconds: number;
};

export type LibraryRuntimeConfig = {
  challengeTtlSeconds: number;
  sessionTtlSeconds: number;
  challengeRateLimit: LibraryRateLimitConfig;
  verifyRateLimit: LibraryRateLimitConfig;
  chainFreshness: {
    maxStaleSeconds: number;
    maxFutureDriftSeconds: number;
    minConfirmations: number;
  };
};

export type LibraryApiError = {
  error: {
    code: LibraryApiErrorCode;
    message: string;
    retryable: boolean;
  };
};

export type LibraryApiMeta = {
  serverTime: number;
  chainTime: number | null;
};
