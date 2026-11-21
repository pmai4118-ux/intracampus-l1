import { getAddress } from "ethers";
import { parseIpAddressList } from "../auth/client-address.ts";

export type AdminSignerRole = "registryAdmin" | "libraryAdmin" | "sbtIssuer" | "grantIssuer" | "funder";

export type AdminConfig = {
  accessKey: string;
  origins: readonly string[];
  cookieName: string;
  secureCookie: boolean;
  sessionTtlSeconds: number;
  loginRateLimit: { maxRequests: number; windowSeconds: number };
  trustedProxyAddresses: readonly string[];
  signers: Partial<Record<AdminSignerRole, string>>;
  rpcUrl?: string;
  allowLocal: boolean;
  defaultWelcomeTreasury?: string;
  defaultScholarshipWei: string;
};

export class AdminConfigurationError extends Error {
  constructor(message = "CONFIGURATION_ERROR") {
    super(message);
    this.name = "AdminConfigurationError";
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!raw?.trim()) return fallback;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) throw new AdminConfigurationError();
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new AdminConfigurationError();
  return value;
}

function parseOptionalPrivateKey(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed) || /^0x0{64}$/i.test(trimmed)) {
    throw new AdminConfigurationError("INVALID_ADMIN_SIGNER_KEY");
  }
  return trimmed;
}

function parseOptionalAddress(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    const normalized = getAddress(trimmed);
    if (/^0x0{40}$/i.test(normalized)) throw new Error();
    return normalized;
  } catch {
    throw new AdminConfigurationError("INVALID_ADMIN_ADDRESS");
  }
}

function parseOrigins(raw: string | undefined, allowInsecureLocalhost: boolean): { origins: string[]; secureCookie: boolean } {
  const entries = (raw ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (entries.length === 0) throw new AdminConfigurationError("ADMIN_AUTH_ORIGIN_REQUIRED");
  const origins: string[] = [];
  let allHttps = true;
  for (const entry of entries) {
    let url: URL;
    try { url = new URL(entry); } catch { throw new AdminConfigurationError("INVALID_ADMIN_ORIGIN"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "")) {
      throw new AdminConfigurationError("INVALID_ADMIN_ORIGIN");
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (url.protocol === "http:") {
      if (!isLocal || !allowInsecureLocalhost) throw new AdminConfigurationError("INSECURE_ADMIN_ORIGIN");
      allHttps = false;
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return { origins, secureCookie: allHttps };
}

export function readAdminConfig(env: Record<string, string | undefined>): AdminConfig {
  const accessKey = env.ADMIN_ACCESS_KEY?.trim();
  if (!accessKey || accessKey.length < 8) {
    throw new AdminConfigurationError("ADMIN_ACCESS_KEY_REQUIRED");
  }
  const allowInsecureLocalhost = env.ADMIN_ALLOW_INSECURE_LOCALHOST === "true"
    || env.LIBRARY_ALLOW_INSECURE_LOCALHOST === "true";
  const rawOrigin = env.ADMIN_AUTH_ORIGIN?.trim()
    || env.CAMPUS_AUTH_ORIGIN?.trim()
    || env.LIBRARY_AUTH_ORIGIN?.trim();
  const { origins, secureCookie } = parseOrigins(rawOrigin, allowInsecureLocalhost);

  const defaultScholarshipWei = env.CAMPUS_SCHOLARSHIP_WEI?.trim() || "1000000000000000000000";
  if (!/^[1-9][0-9]*$/.test(defaultScholarshipWei) || BigInt(defaultScholarshipWei) >= 2n ** 256n) {
    throw new AdminConfigurationError("INVALID_SCHOLARSHIP_WEI");
  }

  const registryKey = parseOptionalPrivateKey(env.ADMIN_REGISTRY_SIGNER_PRIVATE_KEY);
  const libraryKey = parseOptionalPrivateKey(env.ADMIN_LIBRARY_SIGNER_PRIVATE_KEY) ?? registryKey;
  const sbtIssuerKey = parseOptionalPrivateKey(env.ADMIN_SBT_ISSUER_PRIVATE_KEY)
    ?? parseOptionalPrivateKey(env.SEED_ISSUER_PRIVATE_KEY);
  const grantIssuerKey = parseOptionalPrivateKey(env.ADMIN_GRANT_ISSUER_PRIVATE_KEY)
    ?? parseOptionalPrivateKey(env.SEED_GRANT_ISSUER_PRIVATE_KEY);
  const funderKey = parseOptionalPrivateKey(env.ADMIN_FUNDER_PRIVATE_KEY)
    ?? parseOptionalPrivateKey(env.SEED_FUNDER_PRIVATE_KEY);

  return {
    accessKey,
    origins,
    cookieName: secureCookie ? "__Host-admin_session" : "admin_session",
    secureCookie,
    sessionTtlSeconds: parsePositiveInt(env.ADMIN_SESSION_TTL_SECONDS, 43_200, 604_800),
    loginRateLimit: {
      maxRequests: parsePositiveInt(env.ADMIN_LOGIN_RATE_LIMIT_MAX_REQUESTS, 12, 1_000),
      windowSeconds: parsePositiveInt(env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_SECONDS, 60, 86_400),
    },
    trustedProxyAddresses: env.LIBRARY_TRUSTED_PROXY_ADDRESSES === undefined
      ? ["127.0.0.1", "::1"]
      : parseIpAddressList(env.LIBRARY_TRUSTED_PROXY_ADDRESSES),
    signers: {
      ...(registryKey ? { registryAdmin: registryKey } : {}),
      ...(libraryKey ? { libraryAdmin: libraryKey } : {}),
      ...(sbtIssuerKey ? { sbtIssuer: sbtIssuerKey } : {}),
      ...(grantIssuerKey ? { grantIssuer: grantIssuerKey } : {}),
      ...(funderKey ? { funder: funderKey } : {}),
    },
    rpcUrl: env.INTRACAMPUS_RPC_URL?.trim() || undefined,
    allowLocal: env.ADMIN_ALLOW_LOCAL_ANVIL === "true"
      || env.CAMPUS_ALLOW_LOCAL_ANVIL === "true"
      || env.LIBRARY_ALLOW_LOCAL_ANVIL === "true",
    defaultWelcomeTreasury: parseOptionalAddress(env.CAMPUS_TREASURY_ADDRESS),
    defaultScholarshipWei,
  };
}
