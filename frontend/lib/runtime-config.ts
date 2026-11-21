import type { RuntimeWalletConfig } from "@intracampus/network";
import { isWalletAddress } from "./chains.ts";

function optionalAddress(value: unknown): string | null {
  return isWalletAddress(value) ? value : null;
}

export async function fetchRuntimeWalletConfig(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RuntimeWalletConfig | null> {
  try {
    const response = await fetcher("/api/config/runtime", {
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.any([AbortSignal.timeout(3500), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) return null;
    const raw = (await response.json()) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || typeof raw.chainId !== "number") return null;
    return {
      chainId: raw.chainId as RuntimeWalletConfig["chainId"],
      parkingMerchant: optionalAddress(raw.parkingMerchant),
      canteenMerchant: optionalAddress(raw.canteenMerchant),
      libraryTreasury: optionalAddress(raw.libraryTreasury),
      libraryLibrarian: optionalAddress(raw.libraryLibrarian),
      welcomeTreasury: optionalAddress(raw.welcomeTreasury),
      scholarshipWei: typeof raw.scholarshipWei === "string" ? raw.scholarshipWei : "1000000000000000000000",
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    };
  } catch {
    return null;
  }
}
