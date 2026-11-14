import { LIBRARY_REQUEST_BODY_LIMIT_BYTES } from "../src/index.ts";
import type {
  LibraryLoan,
  LibraryApiErrorCode,
  LibraryRateLimitConfig,
  LibraryRuntimeConfig,
  LibrarySettlementIntent,
  LibrarySettlementPreview,
} from "../src/index.ts";

const bodyLimitBytes: 8192 = LIBRARY_REQUEST_BODY_LIMIT_BYTES;
const runtimeConfig: LibraryRuntimeConfig = {
  challengeTtlSeconds: 60,
  sessionTtlSeconds: 3600,
  challengeRateLimit: { maxRequests: 10, windowSeconds: 60 },
  verifyRateLimit: { maxRequests: 5, windowSeconds: 60 },
  chainFreshness: { maxStaleSeconds: 30, maxFutureDriftSeconds: 0, minConfirmations: 1 },
};
const rateLimit: LibraryRateLimitConfig = runtimeConfig.challengeRateLimit;
declare const intent: LibrarySettlementIntent;
declare const loan: LibraryLoan;

const preview: LibrarySettlementPreview = intent.preview;
const borrower: `0x${string}` = loan.borrower;
const payloadTooLarge: LibraryApiErrorCode = "PAYLOAD_TOO_LARGE";

if (intent.outcome === "RETURNED") {
  const refundWei: string = intent.preview.refundWei;
  void refundWei;
} else {
  const shortfallWei: string = intent.preview.shortfallWei;
  void shortfallWei;
}

void bodyLimitBytes;
void rateLimit;
void preview;
void borrower;
void payloadTooLarge;
