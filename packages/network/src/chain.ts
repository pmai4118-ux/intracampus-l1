export const LOCAL_CAMPUS_CHAIN_ID = 20261;
export const CLOUD_CAMPUS_CHAIN_ID = 20261120;
export type CampusChainId = typeof LOCAL_CAMPUS_CHAIN_ID | typeof CLOUD_CAMPUS_CHAIN_ID;

export function resolveCampusChainId(configured: string | undefined): CampusChainId {
  if (configured === undefined || configured === "" || configured === String(LOCAL_CAMPUS_CHAIN_ID)) {
    return LOCAL_CAMPUS_CHAIN_ID;
  }
  if (configured === String(CLOUD_CAMPUS_CHAIN_ID)) return CLOUD_CAMPUS_CHAIN_ID;
  throw new Error("NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID must select a supported IntraCampus network");
}

// Next.js substitutes this literal public environment reference during the frontend build.
export const CAMPUS_CHAIN_ID = resolveCampusChainId(process.env.NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID);

export const campusNetwork = {
  name: CAMPUS_CHAIN_ID === CLOUD_CAMPUS_CHAIN_ID ? "IntraCampus L1 Cloud Demo" : "IntraCampus L1",
  chainId: CAMPUS_CHAIN_ID,
  nativeCurrency: { name: "Campus", symbol: "CAMPUS", decimals: 18 },
} as const;
