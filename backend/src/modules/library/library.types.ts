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
