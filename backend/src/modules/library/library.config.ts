export type LibraryChainFreshness = {
  maxStaleSeconds: number;
  maxFutureDriftSeconds: number;
  minConfirmations: number;
};

export type LibraryConfig = {
  rpcUrl: string;
  allowLocal: boolean;
  chainFreshness: LibraryChainFreshness;
  deployment?: unknown;
};

export class LibraryConfigurationError extends Error {
  constructor() { super("CONFIGURATION_ERROR"); this.name = "LibraryConfigurationError"; }
}

function integer(env: Record<string, string | undefined>, key: string, minimum: number): number {
  const raw = env[key];
  if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw)) throw new LibraryConfigurationError();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new LibraryConfigurationError();
  return value;
}

export function readLibraryConfig(env: Record<string, string | undefined>, deployment?: unknown): LibraryConfig {
  try {
    const rawUrl = env.INTRACAMPUS_RPC_URL?.trim();
    if (!rawUrl) throw new LibraryConfigurationError();
    const url = new URL(rawUrl);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))
      || url.username || url.password || url.search || url.hash) throw new LibraryConfigurationError();
    const allowLocal = env.LIBRARY_ALLOW_LOCAL_ANVIL === "true";
    if (env.LIBRARY_ALLOW_LOCAL_ANVIL !== undefined && !["true", "false"].includes(env.LIBRARY_ALLOW_LOCAL_ANVIL)) {
      throw new LibraryConfigurationError();
    }
    return {
      rpcUrl: url.href,
      allowLocal,
      chainFreshness: {
        maxStaleSeconds: integer(env, "LIBRARY_CHAIN_MAX_STALE_SECONDS", 1),
        maxFutureDriftSeconds: integer(env, "LIBRARY_CHAIN_MAX_FUTURE_DRIFT_SECONDS", 0),
        minConfirmations: integer(env, "LIBRARY_MIN_CONFIRMATIONS", 1),
      },
      ...(deployment === undefined ? {} : { deployment }),
    };
  } catch (error) {
    if (error instanceof LibraryConfigurationError) throw error;
    throw new LibraryConfigurationError();
  }
}
