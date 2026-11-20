export type CampusReview = "PENDING" | "APPROVED" | "REJECTED";
export type CampusApplication = {
  wallet: string; studentCode: string; program: string; status: CampusReview;
  reason: string; reviewedBy: string | null; updatedAt: number;
};
export type CampusScholarship = { wallet: string; category: "MERIT" | "SUPPORT"; status: CampusReview; reason: string; reviewedBy: string | null };
export type CampusPayout = {
  id: string; wallet: string; kind: "WELCOME" | "SCHOLARSHIP"; status: "PREPARED" | "UNKNOWN" | "PENDING" | "FAILED" | "CONFIRMED";
  from: string; to: string; data: string; value: string; afterBlock: number; txHash: string | null;
};
export type CampusProfile = { application: CampusApplication | null; scholarship: CampusScholarship | null; payouts: CampusPayout[] };
/** Client creates and retains this capability before /begin. Never part of a public profile. */
export type CampusPayoutAttempt = { payout: CampusPayout; attemptToken: string };
