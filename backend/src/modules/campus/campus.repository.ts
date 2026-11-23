import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CampusApplication, CampusScholarship, CampusPayout, CampusProfile } from "@intracampus/network";
import type { AuthStore } from "../auth/auth.service.ts";
import type { LibraryChallengeRecord, LibrarySessionRecord } from "../library/library.types.ts";
import type { AuthRateLimitConfig } from "../auth/auth.config.ts";

export class CampusError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, httpStatus = 409) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
export class CampusRepository implements AuthStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS campus_challenges(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS campus_sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS campus_limits(id TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS campus_applications(wallet TEXT PRIMARY KEY, code TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS campus_verified_identity ON campus_applications(code) WHERE status='APPROVED';
      CREATE TABLE IF NOT EXISTS campus_scholarships(wallet TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS campus_payouts(id TEXT PRIMARY KEY, wallet TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT UNIQUE, data TEXT NOT NULL, UNIQUE(wallet,kind));
      CREATE TABLE IF NOT EXISTS campus_payout_attempts(payout_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, released INTEGER NOT NULL, claimed_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS campus_released_attempts(payout_id TEXT NOT NULL, token_hash TEXT NOT NULL, PRIMARY KEY(payout_id,token_hash));
      INSERT OR IGNORE INTO campus_released_attempts SELECT payout_id,token_hash FROM campus_payout_attempts WHERE released=1;
      CREATE TABLE IF NOT EXISTS campus_audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, wallet TEXT NOT NULL, action TEXT NOT NULL, created INTEGER NOT NULL);`);
    const attemptColumns = this.db.prepare("PRAGMA table_info(campus_payout_attempts)").all().map((row) => String(row.name));
    if (!attemptColumns.includes("claimed_at")) this.db.exec("ALTER TABLE campus_payout_attempts ADD COLUMN claimed_at INTEGER NOT NULL DEFAULT 0");
  }
  close() { this.db.close(); }
  private atomic<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private read<T>(table: string, key: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE ${table === 'campus_scholarships' ? 'wallet' : 'id'}=?`).get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  isAllowlisted(wallet: string) { return { wallet, role: "STUDENT" as const }; }
  createChallenge(input: Omit<LibraryChallengeRecord, "consumedAt">): LibraryChallengeRecord {
    const record = { ...input, consumedAt: null };
    this.db.prepare("DELETE FROM campus_challenges WHERE json_extract(data,'$.expiresAt')<=?").run(input.createdAt);
    this.db.prepare("INSERT INTO campus_challenges VALUES (?,?)").run(input.challengeId, JSON.stringify(record)); return record;
  }
  getChallenge(id: string) { return this.read<LibraryChallengeRecord>("campus_challenges", id); }
  consumeChallengeAndCreateSession(input: { challengeId: string; tokenHash: string; now: number; expiresAt: number }): LibrarySessionRecord {
    return this.atomic(() => {
      const challenge = this.getChallenge(input.challengeId);
      if (!challenge || challenge.consumedAt !== null || challenge.expiresAt <= input.now) throw Error("LIBRARY_CHALLENGE_INVALID");
      challenge.consumedAt = input.now;
      this.db.prepare("UPDATE campus_challenges SET data=? WHERE id=?").run(JSON.stringify(challenge), input.challengeId);
      const record: LibrarySessionRecord = { tokenHash: input.tokenHash, wallet: challenge.wallet, role: "STUDENT", createdAt: input.now, expiresAt: input.expiresAt };
      this.db.prepare("DELETE FROM campus_sessions WHERE json_extract(data,'$.expiresAt')<=?").run(input.now);
      this.db.prepare("INSERT INTO campus_sessions VALUES (?,?)").run(input.tokenHash, JSON.stringify(record)); return record;
    });
  }
  consumeRateLimit(input: { scope: string; subjectHash: string; now: number; config: AuthRateLimitConfig }) {
    return this.atomic(() => {
      const window = Math.floor(input.now / input.config.windowSeconds), key = `${input.scope}:${input.subjectHash}:${window}`;
      this.db.prepare("DELETE FROM campus_limits WHERE expires<=?").run(input.now);
      this.db.prepare("INSERT INTO campus_limits VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1").run(key, (window + 1) * input.config.windowSeconds);
      const count = Number(this.db.prepare("SELECT count FROM campus_limits WHERE id=?").get(key)!.count);
      return { allowed: count <= input.config.maxRequests, retryAfterSeconds: (window + 1) * input.config.windowSeconds - input.now };
    });
  }
  session(key: string, now: number) { const record = this.read<LibrarySessionRecord>("campus_sessions", key); return record && record.expiresAt > now ? record : undefined; }
  revokeSession(key: string) { return this.db.prepare("DELETE FROM campus_sessions WHERE id=?").run(key).changes > 0; }
  profile(wallet: string): CampusProfile {
    const row = this.db.prepare("SELECT data FROM campus_applications WHERE wallet=?").get(wallet.toLowerCase());
    return { application: row ? JSON.parse(String(row.data)) : null, scholarship: this.read<CampusScholarship>("campus_scholarships", wallet.toLowerCase()) ?? null,
      payouts: this.db.prepare("SELECT data FROM campus_payouts WHERE wallet=?").all(wallet.toLowerCase()).map(row => JSON.parse(String(row.data))) };
  }
  list() { return this.db.prepare("SELECT wallet FROM campus_applications ORDER BY rowid DESC LIMIT 200").all().map(row => this.profile(String(row.wallet))); }
  submit(wallet: string, code: string, program: string) {
    wallet = wallet.toLowerCase();
    return this.atomic(() => {
      const old = this.profile(wallet).application;
      if (old && old.status !== "REJECTED") {
        if (old.studentCode === code && old.program === program) return old;
        throw new CampusError("APPLICATION_LOCKED");
      }
      const record: CampusApplication = { wallet, studentCode: code, program, status: "PENDING", reason: "", reviewedBy: null, updatedAt: Date.now() };
      this.db.prepare("INSERT INTO campus_applications VALUES (?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET code=excluded.code,status=excluded.status,data=excluded.data")
        .run(wallet, code, record.status, JSON.stringify(record)); return record;
    });
  }
  requestScholarship(wallet: string, category: CampusScholarship["category"]) {
    wallet = wallet.toLowerCase();
    return this.atomic(() => {
      const profile = this.profile(wallet);
      if (profile.application?.status !== "APPROVED") throw new CampusError("STUDENT_NOT_VERIFIED", 403);
      if (profile.scholarship && profile.scholarship.status !== "REJECTED") return profile.scholarship;
      const record: CampusScholarship = { wallet, category, status: "PENDING", reason: "", reviewedBy: null };
      this.db.prepare("INSERT INTO campus_scholarships VALUES (?,?) ON CONFLICT(wallet) DO UPDATE SET data=excluded.data").run(wallet, JSON.stringify(record)); return record;
    });
  }
  review(actor: string, wallet: string, kind: "STUDENT" | "SCHOLARSHIP", approve: boolean, reason: string) {
    wallet = wallet.toLowerCase();
    return this.atomic(() => {
      const profile = this.profile(wallet), record = kind === "STUDENT" ? profile.application : profile.scholarship;
      if (!record) throw new CampusError("NOT_FOUND", 404);
      if (record.status !== "PENDING") throw new CampusError("ALREADY_REVIEWED");
      if (kind === "SCHOLARSHIP" && profile.application?.status !== "APPROVED") throw new CampusError("STUDENT_NOT_VERIFIED", 403);
      record.status = approve ? "APPROVED" : "REJECTED"; record.reason = reason; record.reviewedBy = actor;
      if (kind === "STUDENT") {
        (record as CampusApplication).updatedAt = Date.now();
        if (approve && this.db.prepare("SELECT 1 FROM campus_applications WHERE code=? AND status='APPROVED' AND wallet<>?").get((record as CampusApplication).studentCode, wallet)) throw new CampusError("STUDENT_ID_ALREADY_VERIFIED");
        this.db.prepare("UPDATE campus_applications SET status=?,data=? WHERE wallet=?").run(record.status, JSON.stringify(record), wallet);
      } else this.db.prepare("UPDATE campus_scholarships SET data=? WHERE wallet=?").run(JSON.stringify(record), wallet);
      this.db.prepare("INSERT INTO campus_audit(actor,wallet,action,created) VALUES (?,?,?,?)").run(actor, wallet, `${kind}:${record.status}`, Date.now()); return this.profile(wallet);
    });
  }
  adminReviewStudent(actor: string, wallet: string, approve: boolean, options: { studentCode?: string; program?: string; reason?: string } = {}) {
    wallet = wallet.toLowerCase();
    return this.atomic(() => {
      const existing = this.profile(wallet).application;
      const code = (options.studentCode?.trim().toUpperCase() || existing?.studentCode || `TEST-${wallet.slice(2, 8).toUpperCase()}`);
      const program = (options.program?.trim() || existing?.program || "Tài khoản test nội bộ");
      const status = approve ? "APPROVED" as const : "REJECTED" as const;
      const reason = options.reason?.trim() || (approve ? "VERIFIED" : "NOT_ELIGIBLE");
      if (approve && this.db.prepare("SELECT 1 FROM campus_applications WHERE code=? AND status='APPROVED' AND wallet<>?").get(code, wallet)) {
        throw new CampusError("STUDENT_ID_ALREADY_VERIFIED");
      }
      const record: CampusApplication = { wallet, studentCode: code, program, status, reason, reviewedBy: actor, updatedAt: Date.now() };
      this.db.prepare("INSERT INTO campus_applications VALUES (?,?,?,?) ON CONFLICT(wallet) DO UPDATE SET code=excluded.code,status=excluded.status,data=excluded.data")
        .run(wallet, code, status, JSON.stringify(record));
      this.db.prepare("INSERT INTO campus_audit(actor,wallet,action,created) VALUES (?,?,?,?)").run(actor, wallet, `ADMIN_STUDENT:${status}`, Date.now());
      return this.profile(wallet);
    });
  }
  adminReviewScholarship(actor: string, wallet: string, approve: boolean, options: { category?: CampusScholarship["category"]; reason?: string } = {}) {
    wallet = wallet.toLowerCase();
    return this.atomic(() => {
      const profile = this.profile(wallet);
      if (approve && profile.application?.status !== "APPROVED") throw new CampusError("STUDENT_NOT_VERIFIED", 403);
      const category = options.category ?? profile.scholarship?.category ?? "SUPPORT";
      const status = approve ? "APPROVED" as const : "REJECTED" as const;
      const reason = options.reason?.trim() || (approve ? "VERIFIED" : "NOT_ELIGIBLE");
      const record: CampusScholarship = { wallet, category, status, reason, reviewedBy: actor };
      this.db.prepare("INSERT INTO campus_scholarships VALUES (?,?) ON CONFLICT(wallet) DO UPDATE SET data=excluded.data")
        .run(wallet, JSON.stringify(record));
      this.db.prepare("INSERT INTO campus_audit(actor,wallet,action,created) VALUES (?,?,?,?)").run(actor, wallet, `ADMIN_SCHOLARSHIP:${status}`, Date.now());
      return this.profile(wallet);
    });
  }
  payout(id: string) { const result = this.read<CampusPayout>("campus_payouts", id); if (!result) throw new CampusError("NOT_FOUND", 404); return result; }
  prepare(record: Omit<CampusPayout, "id" | "status" | "txHash" | "data"> & { data: (id: string) => string }) {
    return this.atomic(() => {
      const previous = this.profile(record.wallet).payouts.find(p => p.kind === record.kind);
      if (previous) return previous;
      const id = randomUUID(), payout: CampusPayout = { ...record, id, data: record.data(id), status: "PREPARED", txHash: null };
      this.db.prepare("INSERT INTO campus_payouts VALUES (?,?,?,NULL,?)").run(id, record.wallet.toLowerCase(), record.kind, JSON.stringify(payout)); return payout;
    });
  }
  begin(id: string, actor: string, attemptToken: string) {
    return this.atomic(() => {
      const p = this.payout(id);
      if (p.from !== actor.toLowerCase() || p.txHash) throw new CampusError("PAYOUT_LOCKED");
      const tokenHash = createHash("sha256").update(attemptToken).digest("hex");
      if (this.db.prepare("SELECT 1 FROM campus_released_attempts WHERE payout_id=? AND token_hash=?").get(id, tokenHash)) throw new CampusError("PAYOUT_ATTEMPT_RELEASED");
      const attempt = this.db.prepare("SELECT token_hash,released FROM campus_payout_attempts WHERE payout_id=?").get(id);
      // A lost response can be retried by the same caller without changing the durable lock.
      if (p.status === "UNKNOWN" && attempt?.token_hash === tokenHash && Number(attempt.released) === 0) return { payout: p, attemptToken };
      if (p.status !== "PREPARED") throw new CampusError("PAYOUT_LOCKED");
      this.db.prepare("INSERT INTO campus_payout_attempts(payout_id,token_hash,released,claimed_at) VALUES (?,?,0,?) ON CONFLICT(payout_id) DO UPDATE SET token_hash=excluded.token_hash,released=0,claimed_at=excluded.claimed_at")
        .run(id, tokenHash, Date.now());
      p.status = "UNKNOWN"; this.savePayout(p);
      return { payout: p, attemptToken };
    });
  }
  beginSystemPayout(id: string, now = Date.now(), staleAfterMs = 120_000) {
    return this.atomic(() => {
      const p = this.payout(id);
      if (p.txHash) return { payout: p, attemptToken: null as string | null };
      if (p.status !== "PREPARED" && p.status !== "UNKNOWN") throw new CampusError("PAYOUT_LOCKED");
      const previous = this.db.prepare("SELECT released,claimed_at FROM campus_payout_attempts WHERE payout_id=?").get(id);
      if (p.status === "UNKNOWN" && previous && Number(previous.released) === 0 && Number(previous.claimed_at) > now - staleAfterMs) {
        throw new CampusError("PAYOUT_IN_PROGRESS", 409);
      }
      const attemptToken = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(attemptToken).digest("hex");
      this.db.prepare(`INSERT INTO campus_payout_attempts(payout_id,token_hash,released,claimed_at) VALUES (?,?,0,?)
        ON CONFLICT(payout_id) DO UPDATE SET token_hash=excluded.token_hash,released=0,claimed_at=excluded.claimed_at`).run(id, tokenHash, now);
      if (p.status !== "UNKNOWN") { p.status = "UNKNOWN"; this.savePayout(p); }
      return { payout: p, attemptToken };
    });
  }
  release(id: string, actor: string, attemptToken: string, outcome: "REJECTED" | "NOT_SENT") {
    return this.atomic(() => {
      const p = this.payout(id);
      const tokenHash = createHash("sha256").update(attemptToken).digest("hex");
      const attempt = this.db.prepare("SELECT token_hash,released FROM campus_payout_attempts WHERE payout_id=?").get(id);
      if (p.from !== actor.toLowerCase() || p.txHash) throw new CampusError("PAYOUT_LOCKED");
      if (p.status === "UNKNOWN") {
        if (attempt?.token_hash !== tokenHash || Number(attempt.released) !== 0) throw new CampusError("PAYOUT_LOCKED");
        p.status = "PREPARED"; this.savePayout(p);
        this.db.prepare("UPDATE campus_payout_attempts SET released=1 WHERE payout_id=?").run(id);
      } else if (p.status !== "PREPARED" || (attempt && Number(attempt.released) === 0)) throw new CampusError("PAYOUT_LOCKED");
      // Release may arrive before a slow begin commits. Remember the cancellation so that
      // late/replayed requests can never resurrect it, even after another attempt is released.
      const inserted = this.db.prepare("INSERT OR IGNORE INTO campus_released_attempts VALUES (?,?)").run(id, tokenHash);
      if (inserted.changes) this.db.prepare("INSERT INTO campus_audit(actor,wallet,action,created) VALUES (?,?,?,?)")
        .run(actor.toLowerCase(), p.wallet, `PAYOUT:${outcome}`, Date.now());
      return p;
    });
  }
  private savePayout(p: CampusPayout) { this.db.prepare("UPDATE campus_payouts SET hash=?,data=? WHERE id=?").run(p.txHash, JSON.stringify(p), p.id); }
  attach(id: string, hash: string) {
    return this.atomic(() => {
      const p = this.payout(id);
      if (p.status === "PREPARED") throw new CampusError("PAYOUT_NOT_STARTED");
      if (p.txHash === hash) return p;
      if (p.txHash) throw new CampusError("HASH_ALREADY_ATTACHED");
      const other = this.db.prepare("SELECT id FROM campus_payouts WHERE hash=? AND id<>?").get(hash, id);
      if (other) throw new CampusError("HASH_ALREADY_USED");
      p.txHash = hash;
      p.status = "PENDING";
      this.savePayout(p);
      return p;
    });
  }
  finish(id: string, hash: string, status: "CONFIRMED" | "FAILED") { return this.atomic(() => { const p = this.payout(id); if (p.txHash !== hash) throw new CampusError("HASH_MISMATCH"); p.status = status; this.savePayout(p); return p; }); }
}
