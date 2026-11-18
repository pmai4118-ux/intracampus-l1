export type InvoiceChainFreshness = {
  maxStaleSeconds: number;
  maxFutureDriftSeconds: number;
};

export const defaultInvoiceChainFreshness: Readonly<InvoiceChainFreshness> = Object.freeze({
  maxStaleSeconds: 300,
  maxFutureDriftSeconds: 30,
});

function seconds(env: Record<string, string | undefined>, key: string, fallback: number, minimum: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`Invalid ${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${key}`);
  return value;
}

export function readInvoiceChainFreshness(env: Record<string, string | undefined>): InvoiceChainFreshness {
  return {
    maxStaleSeconds: seconds(env, "INVOICE_CHAIN_MAX_STALE_SECONDS", defaultInvoiceChainFreshness.maxStaleSeconds, 1),
    maxFutureDriftSeconds: seconds(env, "INVOICE_CHAIN_MAX_FUTURE_DRIFT_SECONDS", defaultInvoiceChainFreshness.maxFutureDriftSeconds, 0),
  };
}

export function isFreshInvoiceChainTimestamp(timestamp: number, nowMs: number, freshness: InvoiceChainFreshness): boolean {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isFinite(nowMs)
    || !Number.isSafeInteger(freshness.maxStaleSeconds) || freshness.maxStaleSeconds < 1
    || !Number.isSafeInteger(freshness.maxFutureDriftSeconds) || freshness.maxFutureDriftSeconds < 0) return false;
  const ageSeconds = Math.floor(nowMs / 1000) - timestamp;
  return ageSeconds <= freshness.maxStaleSeconds && ageSeconds >= -freshness.maxFutureDriftSeconds;
}
