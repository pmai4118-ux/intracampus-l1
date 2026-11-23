import type { CampusChainId } from "./chain.ts";
import type { CampusApplication, CampusPayout, CampusScholarship } from "./campus.ts";
import type { CampusAuthRole } from "./library.ts";

export type RuntimeWalletConfig = {
  chainId: CampusChainId;
  parkingMerchant: string | null;
  canteenMerchant: string | null;
  libraryTreasury: string | null;
  libraryLibrarian: string | null;
  welcomeTreasury: string | null;
  scholarshipWei: string;
  updatedAt: number;
};

export type AdminSignerStatus = {
  role: "registryAdmin" | "libraryAdmin" | "sbtIssuer" | "grantIssuer" | "funder";
  label: string;
  configured: boolean;
  expectedAddress: string | null;
  signerAddress: string | null;
  matchesOnChain: boolean | null;
  balanceWei: string | null;
};

export type NativeMinterStatus = {
  supported: boolean;
  ready: boolean;
  chainId: number | null;
  signerAddress: string | null;
  role: number | null;
  reason: string | null;
};

export type AdminWalletSlot = {
  id: "parking" | "canteen" | "libraryTreasury" | "libraryLibrarian";
  label: string;
  description: string;
  address: string | null;
  manifestAddress: string | null;
  overridden: boolean;
  balanceWei: string | null;
  allowedOnChain: boolean | null;
  mutableOnChain: boolean;
  mutableReason?: string | null;
};

export type AdminOverview = {
  chainId: CampusChainId;
  networkName: string;
  deploymentStatus: "deployed" | "unconfigured";
  blockNumber: number | null;
  blockTimestamp: number | null;
  contracts: {
    studentSbt: string | null;
    paymentRegistry: string | null;
    grantVault: string | null;
    libraryEscrow: string | null;
  };
  wallets: {
    parking: AdminWalletSlot;
    canteen: AdminWalletSlot;
    libraryTreasury: AdminWalletSlot;
    libraryLibrarian: AdminWalletSlot;
  };
  campusSettings: {
    welcomeTreasury: string | null;
    scholarshipWei: string;
  };
  nativeMinter: NativeMinterStatus;
  signers: AdminSignerStatus[];
  counts: {
    applicationsTotal: number;
    applicationsPending: number;
    applicationsApproved: number;
    scholarshipsPending: number;
    scholarshipsApproved: number;
    heldAccounts: number;
  };
};

export type AdminStudentRecord = {
  wallet: string;
  application: CampusApplication | null;
  scholarship: CampusScholarship | null;
  payouts: CampusPayout[];
  libraryAccount: {
    role: CampusAuthRole;
    enabled: boolean;
    held: boolean;
    blockingLoanIds: string[];
  } | null;
  onChain: {
    balanceWei: string | null;
    sbtTokenId: string | null;
    sbtExpiresAt: number | null;
    sbtTier: number | null;
    foodGrantBalanceWei: string | null;
  };
};

export type AdminAuditEntry = {
  id: number;
  action: string;
  target: string;
  summary: string;
  txHash: string | null;
  status: "DONE" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  errorCode: string | null;
  createdAt: number;
};

export type AdminTxStatus = {
  txHash: string;
  status: "SUBMITTED" | "CONFIRMED" | "FAILED";
  blockNumber: number | null;
  blockHash: string | null;
};

export type NativeCampusMintOperation = {
  requestId: string;
  wallet: string;
  amountWei: string;
  txHash: string | null;
  status: "READY" | "IN_PROGRESS" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  audit: AdminAuditEntry | null;
};
