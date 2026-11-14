export type AuthRateLimitConfig = { maxRequests: number; windowSeconds: number };
export type LibraryAuthConfig = {
  origin: string;
  domain: string;
  chainId: 20261;
  challengeTtlSeconds: number;
  sessionTtlSeconds: number;
  challengeRateLimit: AuthRateLimitConfig;
  verifyRateLimit: AuthRateLimitConfig;
  cookieName: string;
  secureCookie: boolean;
};

export const maxAuthUnixSeconds = 8_640_000_000_000;

export class AuthConfigurationError extends Error {
  constructor() { super("CONFIGURATION_ERROR"); this.name = "AuthConfigurationError"; }
}

function positiveInteger(env: Record<string, string | undefined>, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = env[name];
  if (!value || !/^[1-9][0-9]*$/.test(value)) throw new AuthConfigurationError();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw new AuthConfigurationError();
  return number;
}

function rateLimit(env: Record<string, string | undefined>, prefix: string): AuthRateLimitConfig {
  return {
    maxRequests: positiveInteger(env, `${prefix}_MAX_REQUESTS`),
    windowSeconds: positiveInteger(env, `${prefix}_WINDOW_SECONDS`),
  };
}

export function readLibraryAuthConfig(env: Record<string, string | undefined>, nowSeconds = Math.floor(Date.now() / 1000)): LibraryAuthConfig {
  try {
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 || nowSeconds >= maxAuthUnixSeconds) throw new AuthConfigurationError();
    const maxTtlSeconds = maxAuthUnixSeconds - nowSeconds;
    const rawOrigin = env.LIBRARY_AUTH_ORIGIN?.trim();
    if (!rawOrigin) throw new AuthConfigurationError();
    const url = new URL(rawOrigin);
    if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "")) throw new AuthConfigurationError();
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const localHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    const secureCookie = url.protocol === "https:";
    if (!secureCookie && (!localHost || env.LIBRARY_ALLOW_INSECURE_LOCALHOST !== "true")) throw new AuthConfigurationError();
    return {
      origin: url.origin,
      domain: url.host,
      chainId: 20261,
      challengeTtlSeconds: positiveInteger(env, "LIBRARY_CHALLENGE_TTL_SECONDS", maxTtlSeconds),
      sessionTtlSeconds: positiveInteger(env, "LIBRARY_SESSION_TTL_SECONDS", maxTtlSeconds),
      challengeRateLimit: rateLimit(env, "LIBRARY_CHALLENGE_RATE_LIMIT"),
      verifyRateLimit: rateLimit(env, "LIBRARY_VERIFY_RATE_LIMIT"),
      cookieName: secureCookie ? "__Host-library_session" : "library_session",
      secureCookie,
    };
  } catch (error) {
    if (error instanceof AuthConfigurationError) throw error;
    throw new AuthConfigurationError();
  }
}
