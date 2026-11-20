import { createHash, randomBytes } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { maxAuthUnixSeconds, type LibraryAuthConfig } from "./auth.config.ts";
import { AuthRepository } from "./auth.repository.ts";
export type AuthStore = Pick<AuthRepository, "isAllowlisted" | "createChallenge" | "getChallenge" | "consumeChallengeAndCreateSession" | "consumeRateLimit" | "session" | "revokeSession">;

export type AuthFailureCode = "VALIDATION_ERROR" | "UNAUTHENTICATED" | "RATE_LIMITED" | "CONFIGURATION_ERROR" | "DATABASE_BUSY" | "INTERNAL_ERROR";

const failureStatus: Record<AuthFailureCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  RATE_LIMITED: 429,
  CONFIGURATION_ERROR: 503,
  DATABASE_BUSY: 503,
  INTERNAL_ERROR: 500,
};

export class AuthError extends Error {
  readonly code: AuthFailureCode;
  readonly retryAfterSeconds: number;
  readonly httpStatus: number;
  readonly retryable: boolean;
  constructor(code: AuthFailureCode, retryAfterSeconds = 0) {
    super(code);
    this.name = "AuthError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.httpStatus = failureStatus[code];
    this.retryable = code === "RATE_LIMITED" || code === "DATABASE_BUSY";
  }
}

function unixSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maxAuthUnixSeconds) throw new AuthError("INTERNAL_ERROR");
  return value;
}

function expirySeconds(now: number, ttlSeconds: number): number {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > maxAuthUnixSeconds - now) {
    throw new AuthError("CONFIGURATION_ERROR");
  }
  return now + ttlSeconds;
}

function iso(value: number): string {
  try { return new Date(unixSeconds(value) * 1000).toISOString(); }
  catch { throw new AuthError("INTERNAL_ERROR"); }
}

function walletAddress(value: unknown): string {
  if (typeof value !== "string") throw new AuthError("VALIDATION_ERROR");
  try {
    const wallet = getAddress(value);
    if (/^0x0{40}$/i.test(wallet)) throw new Error();
    return wallet;
  } catch { throw new AuthError("VALIDATION_ERROR"); }
}

function isDatabaseBusy(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && error.code.includes("SQLITE_BUSY");
}

function nonceValue(): string { return randomBytes(16).toString("hex"); }
function idValue(): string { return randomBytes(24).toString("base64url"); }
function tokenValue(): string { return randomBytes(32).toString("base64url"); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function buildLibraryChallengeMessage(input: {
  wallet: string; nonce: string; createdAt: number; expiresAt: number; config: LibraryAuthConfig;
}): string {
  if (!/^[A-Za-z0-9]{8,}$/.test(input.nonce) || input.expiresAt <= input.createdAt) throw new AuthError("INTERNAL_ERROR");
  return `${input.config.domain} wants you to sign in with your Ethereum account:\n${input.wallet}\n\n`
    + `${input.config.statement ?? "Sign in to IntraCampus Library."}\n\n`
    + `URI: ${input.config.origin}\nVersion: 1\nChain ID: ${input.config.chainId}\nNonce: ${input.nonce}\n`
    + `Issued At: ${iso(input.createdAt)}\nExpiration Time: ${iso(input.expiresAt)}`;
}

export class AuthService {
  private readonly repository: AuthStore;
  private readonly config: LibraryAuthConfig;
  private readonly now: () => number;

  constructor(
    repository: AuthStore,
    config: LibraryAuthConfig,
    now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.repository = repository;
    this.config = config;
    this.now = now;
  }

  createChallenge(input: { wallet: unknown; remoteAddress: string }): { challengeId: string; message: string; expiresAt: number } {
    const now = unixSeconds(this.now());
    this.enforceRateLimit("challenge", input.remoteAddress, now);
    const wallet = walletAddress(input.wallet);
    try {
      if (!this.repository.isAllowlisted(wallet)) throw new AuthError("UNAUTHENTICATED");
    } catch (error) { throw this.normalizeError(error); }
    const expiresAt = expirySeconds(now, this.config.challengeTtlSeconds);
    const nonce = nonceValue();
    const challengeId = idValue();
    const message = buildLibraryChallengeMessage({ wallet, nonce, createdAt: now, expiresAt, config: this.config });
    try {
      this.repository.createChallenge({ challengeId, wallet, nonce, message, createdAt: now, expiresAt });
    } catch (error) { throw this.normalizeError(error); }
    return { challengeId, message, expiresAt };
  }

  verifyChallenge(input: { challengeId: unknown; signature: unknown; remoteAddress: string }): {
    token: string; account: { wallet: string; role: "STUDENT" | "LIBRARIAN" }; expiresAt: number;
  } {
    const now = unixSeconds(this.now());
    this.enforceRateLimit("verify", input.remoteAddress, now);
    if (typeof input.challengeId !== "string" || !/^[A-Za-z0-9_-]{24,200}$/.test(input.challengeId)
      || typeof input.signature !== "string" || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(input.signature)) {
      throw new AuthError("VALIDATION_ERROR");
    }
    let challenge;
    try { challenge = this.repository.getChallenge(input.challengeId); }
    catch (error) { throw this.normalizeError(error); }
    if (!challenge || challenge.consumedAt !== null || challenge.expiresAt <= now) throw new AuthError("UNAUTHENTICATED");
    const wallet = walletAddress(challenge.wallet);
    const expectedMessage = buildLibraryChallengeMessage({ wallet, nonce: challenge.nonce, createdAt: challenge.createdAt,
      expiresAt: challenge.expiresAt, config: this.config });
    if (expectedMessage !== challenge.message) throw new AuthError("UNAUTHENTICATED");
    try {
      if (getAddress(verifyMessage(challenge.message, input.signature)).toLowerCase() !== wallet.toLowerCase()) {
        throw new AuthError("UNAUTHENTICATED");
      }
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("UNAUTHENTICATED");
    }
    const token = tokenValue();
    const expiresAt = expirySeconds(now, this.config.sessionTtlSeconds);
    try {
      const session = this.repository.consumeChallengeAndCreateSession({ challengeId: challenge.challengeId,
        tokenHash: hash(token), now, expiresAt });
      return { token, account: { wallet: session.wallet, role: session.role }, expiresAt: session.expiresAt };
    } catch (error) { throw this.normalizeError(error); }
  }

  session(token: unknown): { account: { wallet: string; role: "STUDENT" | "LIBRARIAN" }; expiresAt: number } | undefined {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").length !== 32) return undefined;
    try {
      const session = this.repository.session(hash(token), unixSeconds(this.now()));
      return session ? { account: { wallet: session.wallet, role: session.role }, expiresAt: session.expiresAt } : undefined;
    } catch (error) { throw this.normalizeError(error); }
  }

  logout(token: unknown): boolean {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").length !== 32) return false;
    try { return this.repository.revokeSession(hash(token), unixSeconds(this.now())); }
    catch (error) { throw this.normalizeError(error); }
  }

  private enforceRateLimit(scope: "challenge" | "verify", remoteAddress: string, now: number): void {
    if (typeof remoteAddress !== "string" || !remoteAddress || remoteAddress.length > 100) throw new AuthError("INTERNAL_ERROR");
    const subjectHash = hash(remoteAddress.toLowerCase());
    const config = scope === "challenge" ? this.config.challengeRateLimit : this.config.verifyRateLimit;
    try {
      const result = this.repository.consumeRateLimit({ scope, subjectHash, now, config });
      if (!result.allowed) throw new AuthError("RATE_LIMITED", result.retryAfterSeconds);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw this.normalizeError(error);
    }
  }

  private normalizeError(error: unknown): AuthError {
    if (error instanceof AuthError) return error;
    if (error instanceof Error && error.message === "LIBRARY_CHALLENGE_INVALID") return new AuthError("UNAUTHENTICATED");
    return new AuthError(isDatabaseBusy(error) ? "DATABASE_BUSY" : "INTERNAL_ERROR");
  }
}
