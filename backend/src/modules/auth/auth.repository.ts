import type { LibraryRepository } from "../library/library.repository.ts";
import type { LibraryChallengeRecord, LibrarySessionRecord } from "../library/library.types.ts";
import type { AuthRateLimitConfig } from "./auth.config.ts";

export class AuthRepository {
  private readonly library: LibraryRepository;

  constructor(library: LibraryRepository) { this.library = library; }

  isAllowlisted(wallet: string): { wallet: string; role: CampusAuthRole } | undefined {
    const account = this.library.accountForWallet(wallet);
    if (!account?.enabled) return undefined;
    return { wallet: account.wallet, role: account.role };
  }

  createChallenge(input: { challengeId: string; wallet: string; nonce: string; message: string; createdAt: number; expiresAt: number }): LibraryChallengeRecord {
    return this.library.createChallenge(input);
  }

  getChallenge(challengeId: string): LibraryChallengeRecord | undefined {
    return this.library.getChallenge(challengeId);
  }

  consumeChallengeAndCreateSession(input: { challengeId: string; tokenHash: string; now: number; expiresAt: number }): LibrarySessionRecord {
    return this.library.consumeChallengeAndCreateSession(input);
  }

  consumeRateLimit(input: { scope: "challenge" | "verify"; subjectHash: string; now: number; config: AuthRateLimitConfig }):
    { allowed: boolean; retryAfterSeconds: number } {
    return this.library.consumeAuthRateLimit({ ...input, maxRequests: input.config.maxRequests, windowSeconds: input.config.windowSeconds });
  }

  session(tokenHash: string, now: number): LibrarySessionRecord | undefined {
    return this.library.getSession(tokenHash, now);
  }

  revokeSession(tokenHash: string, now: number): boolean {
    return this.library.revokeSession(tokenHash, now);
  }
}
import type { CampusAuthRole } from "@intracampus/network";
