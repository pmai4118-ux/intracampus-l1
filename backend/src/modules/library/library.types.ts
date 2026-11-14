export type LibraryDbRole = "STUDENT" | "LIBRARIAN";
export type LibraryCopyStatus = "AVAILABLE" | "PENDING_APPROVAL" | "ON_LOAN" | "RETURN_REVIEW" | "MAINTENANCE" | "LOST";
export type LibraryDbRequestStatus =
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
export type LibraryDbRefundStatus = "NONE" | "REFUND_DUE" | "REFUNDED";

export type LibraryAccountSeed = { wallet: string; role: LibraryDbRole };
export type LibraryCopySeed = { copyId: string; barcode: string };
export type LibraryBookSeed = {
  bookId: string;
  title: string;
  author: string;
  isbn: string | null;
  depositWei: string;
  replacementPriceWei: string;
  copies: LibraryCopySeed[];
};
export type LibraryDemoSeed = {
  version: number;
  books: LibraryBookSeed[];
  accounts: LibraryAccountSeed[];
};

export type LibraryBookRecord = {
  bookId: string;
  title: string;
  author: string;
  isbn: string | null;
  depositWei: string;
  replacementPriceWei: string;
  copiesTotal: number;
  copiesAvailable: number;
};

export type LibraryVerifiedDeposit = {
  requestId: string;
  borrower: string;
  bookId: string;
  depositWei: string;
  approvalDeadline: number;
  chainId: 20261;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  eventName: "DepositReceived";
  occurredAt: number;
};

export type LibraryVerifiedChainEventBase = {
  chainId: 20261;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  transactionFrom: string;
  observedAt: number;
};

export type LibraryVerifiedChainEvent = LibraryVerifiedChainEventBase & (
  | { eventName: "DepositReceived"; requestId: string; borrower: string; bookId: string; amountWei: string;
      depositedAt: number; approvalDeadline: number }
  | { eventName: "LoanApproved"; requestId: string; borrower: string; approvedAt: number; dueAt: number; replacementPriceWei: string }
  | { eventName: "RequestRejected"; requestId: string; borrower: string; refundWei: string }
  | { eventName: "ExpiredRefundClaimed"; requestId: string; borrower: string; refundWei: string }
  | { eventName: "PhysicalReturnConfirmed"; requestId: string; borrower: string; returnedAt: number }
  | { eventName: "ReturnSettled"; requestId: string; borrower: string; returnedAt: number; lateFeeWei: string; repairFeeWei: string;
      overdueForfeitWei: string; totalRetainedWei: string; refundWei: string; maintenanceRequired: boolean }
  | { eventName: "LostSettled"; requestId: string; borrower: string; replacementPriceWei: string; retainedWei: string; refundWei: string;
      shortfallWei: string }
  | { eventName: "ShortfallPaid"; requestId: string; borrower: string; amountWei: string }
);

export type LibraryStoredTransaction = {
  requestId: string;
  action: "deposit" | "approve" | "reject" | "refund" | "confirmReturn" | "return" | "settle" | "payShortfall";
  txHash: string;
  status: "SUBMITTED" | "CONFIRMED" | "REVERTED";
  submittedAt: number;
  blockNumber: number | null;
  blockHash: string | null;
  logIndex: number | null;
  eventName: string | null;
};

export type LibrarySettlementIntentRecord = {
  intentId: string;
  requestId: string;
  loanId: string;
  librarianWallet: string;
  outcome: "RETURNED" | "LOST";
  condition: "GOOD" | "DAMAGED" | null;
  reason: string;
  repairRequestedWei: string | null;
  createdAt: number;
};

export type LibraryDepositProjection = {
  requestId: string;
  status: LibraryDbRequestStatus;
  refundStatus: LibraryDbRefundStatus;
  copyId: string | null;
  approvalDeadline: number;
  duplicate: boolean;
};

export type LibraryRequestRecord = {
  requestId: string;
  wallet: string;
  bookId: string;
  copyId: string | null;
  status: LibraryDbRequestStatus;
  refundStatus: LibraryDbRefundStatus;
  depositWei: string | null;
  approvalDeadline: number | null;
  createdAt: number;
  updatedAt: number;
};

export type LibrarySessionRecord = {
  tokenHash: string;
  wallet: string;
  role: LibraryDbRole;
  createdAt: number;
  expiresAt: number;
};

export type LibraryChallengeRecord = {
  challengeId: string;
  wallet: string;
  nonce: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
};
