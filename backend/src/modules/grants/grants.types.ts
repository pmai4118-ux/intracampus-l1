export class GrantError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export type GrantSnapshot = { blockNumber: number; blockHash: string; balanceWei: bigint; merchantAllowed: boolean };
export type VerifiedGrantEvent = {
  event: "GrantIssued" | "GrantSpent"; transactionHash: string; blockNumber: number; blockHash: string;
  logIndex: number; beneficiary: string; category: string; amountWei: string; balanceWei: string;
  issuer?: string; merchant?: string;
};

export type GrantLookup = {
  schemaVersion: 1; status: "verified"; chainId: 20261; beneficiary: string; vaultAddress: string;
  category: { id: string; label: "FOOD" }; balanceWei: string; block: { number: number; hash: string };
  allowedMerchants: { id: "canteen"; address: string; allowed: boolean }[];
  transaction: null | { hash: string; status: "pending" | "verified"; events: VerifiedGrantEvent[] };
};
