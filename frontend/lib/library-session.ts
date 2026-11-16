import type { LibraryAccountStatus, LibraryRole } from "@intracampus/network";
import { isWalletAddress } from "./chains.ts";

export type LibraryStudentSession = { account: { wallet: string; role: "STUDENT" | "LIBRARIAN" }; expiresAt: number };
export type LibraryStudentAccess =
  | { status: "sign-in-required"; blockingLoanIds: [] }
  | { status: "ready"; session: LibraryStudentSession; accountStatus: LibraryAccountStatus }
  | { status: "held"; session: LibraryStudentSession; accountStatus: LibraryAccountStatus }
  | { status: "error"; code: string; blockingLoanIds: [] };

export class LibrarySessionError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;
  constructor(code: string, retryAfterSeconds?: number) {
    super(code); this.name = "LibrarySessionError"; this.code = code; this.retryAfterSeconds = retryAfterSeconds;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LibrarySessionError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function parseSession(value: unknown): LibraryStudentSession {
  const body = object(value), account = object(body.account);
  if (!isWalletAddress(account.wallet) || !["STUDENT", "LIBRARIAN"].includes(String(account.role))
    || typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt) || body.expiresAt < 0) {
    throw new LibrarySessionError("INVALID_RESPONSE");
  }
  return { account: { wallet: account.wallet, role: account.role as LibraryStudentSession["account"]["role"] }, expiresAt: body.expiresAt };
}
export function parseAccountStatus(value: unknown): LibraryAccountStatus {
  const body = object(value);
  if (typeof body.held !== "boolean" || typeof body.checkedAt !== "number" || !Number.isSafeInteger(body.checkedAt) || body.checkedAt < 0
    || !Array.isArray(body.blockingLoanIds) || !body.blockingLoanIds.every((id) => typeof id === "string" && /^0x[0-9a-f]{64}$/i.test(id))) {
    throw new LibrarySessionError("INVALID_RESPONSE");
  }
  return { held: body.held, checkedAt: body.checkedAt, blockingLoanIds: body.blockingLoanIds as LibraryAccountStatus["blockingLoanIds"] };
}
async function errorCode(response: Response): Promise<string> {
  try { return String(object(object(await response.json()).error).code ?? "SESSION_UNAVAILABLE"); }
  catch { return "SESSION_UNAVAILABLE"; }
}
function request(fetcher: typeof fetch, path: string, init: RequestInit = {}) {
  return fetcher(path, { ...init, cache: "no-store", credentials: "same-origin" });
}
async function currentSession(fetcher: typeof fetch): Promise<LibraryStudentSession | null> {
  const response = await request(fetcher, "/api/auth/session");
  if (response.status === 401) return null;
  if (!response.ok) throw new LibrarySessionError(await errorCode(response), Number(response.headers.get("retry-after")) || undefined);
  try { return parseSession(await response.json()); }
  catch { throw new LibrarySessionError("INVALID_RESPONSE"); }
}

export async function readLibraryStudentAccess(wallet: string, fetcher: typeof fetch = fetch): Promise<LibraryStudentAccess> {
  if (!isWalletAddress(wallet)) return { status: "error", code: "WALLET_REQUIRED", blockingLoanIds: [] };
  let session: LibraryStudentSession | null;
  try { session = await currentSession(fetcher); }
  catch (error) { return { status: "error", code: error instanceof LibrarySessionError ? error.code : "SESSION_UNAVAILABLE", blockingLoanIds: [] }; }
  if (!session || session.account.wallet.toLowerCase() !== wallet.toLowerCase()) return { status: "sign-in-required", blockingLoanIds: [] };
  if (session.account.role !== "STUDENT") return { status: "error", code: "FORBIDDEN", blockingLoanIds: [] };
  try {
    const response = await request(fetcher, "/api/library/account-status");
    if (response.status === 401) return { status: "sign-in-required", blockingLoanIds: [] };
    if (!response.ok) return { status: "error", code: await errorCode(response), blockingLoanIds: [] };
    const accountStatus = parseAccountStatus(await response.json());
    return accountStatus.held ? { status: "held", session, accountStatus } : { status: "ready", session, accountStatus };
  } catch (error) {
    return { status: "error", code: error instanceof LibrarySessionError ? error.code : "SESSION_UNAVAILABLE", blockingLoanIds: [] };
  }
}

export async function signInLibraryWallet(wallet: string, role: LibraryRole,
  signMessage: (account: string, message: string) => Promise<string>, fetcher: typeof fetch = fetch): Promise<void> {
  if (!isWalletAddress(wallet)) throw new LibrarySessionError("WALLET_REQUIRED");
  const existing = await currentSession(fetcher);
  if (existing?.account.wallet.toLowerCase() === wallet.toLowerCase()) {
    if (existing.account.role !== role) throw new LibrarySessionError("FORBIDDEN");
    return;
  }
  const challengeResponse = await request(fetcher, "/api/auth/challenge", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) });
  if (!challengeResponse.ok) throw new LibrarySessionError(await errorCode(challengeResponse), Number(challengeResponse.headers.get("retry-after")) || undefined);
  let challenge: Record<string, unknown>;
  try { challenge = object(await challengeResponse.json()); }
  catch { throw new LibrarySessionError("INVALID_RESPONSE"); }
  if (typeof challenge.challengeId !== "string" || !challenge.challengeId || typeof challenge.message !== "string"
    || !challenge.message || typeof challenge.expiresAt !== "number" || !Number.isSafeInteger(challenge.expiresAt)) {
    throw new LibrarySessionError("INVALID_RESPONSE");
  }
  const signature = await signMessage(wallet, challenge.message);
  const verifyResponse = await request(fetcher, "/api/auth/verify", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.challengeId, signature }) });
  if (!verifyResponse.ok) throw new LibrarySessionError(await errorCode(verifyResponse), Number(verifyResponse.headers.get("retry-after")) || undefined);
  let verified: LibraryStudentSession;
  try { verified = parseSession(await verifyResponse.json()); }
  catch { throw new LibrarySessionError("INVALID_RESPONSE"); }
  if (verified.account.wallet.toLowerCase() !== wallet.toLowerCase() || verified.account.role !== role) {
    throw new LibrarySessionError("WALLET_SESSION_CHANGED");
  }
}

export async function signInLibraryStudent(wallet: string, signMessage: (account: string, message: string) => Promise<string>,
  fetcher: typeof fetch = fetch): Promise<LibraryStudentAccess> {
  await signInLibraryWallet(wallet, "STUDENT", signMessage, fetcher);
  return readLibraryStudentAccess(wallet, fetcher);
}

export async function requireLibraryStudentNotHeld(wallet: string, fetcher: typeof fetch = fetch): Promise<void> {
  const session = await currentSession(fetcher);
  if (!session) throw new LibrarySessionError("UNAUTHENTICATED");
  if (session.account.wallet.toLowerCase() !== wallet.toLowerCase()) throw new LibrarySessionError("WALLET_SESSION_CHANGED");
  if (session.account.role !== "STUDENT") throw new LibrarySessionError("FORBIDDEN");
  const response = await request(fetcher, "/api/library/account-status");
  if (!response.ok) throw new LibrarySessionError(await errorCode(response), Number(response.headers.get("retry-after")) || undefined);
  const status = parseAccountStatus(await response.json());
  if (status.held) throw new LibrarySessionError("ACCOUNT_HELD");
}

export function librarySessionMessage(code: string): string {
  return ({
    WALLET_REQUIRED: "Kết nối ví sinh viên trên IntraCampus L1 trước khi đăng nhập.",
    UNAUTHENTICATED: "Đăng nhập bằng chữ ký ví sinh viên để tiếp tục.",
    WALLET_SESSION_CHANGED: "Session hoặc ví đang chọn không khớp. Đăng nhập lại bằng ví hiện tại.",
    ACCOUNT_HELD: "Tài khoản đang bị giữ do khoản mượn quá hạn hoặc còn thiếu tiền. Xử lý khoản mượn trước khi giao dịch.",
    FORBIDDEN: "Tài khoản này không có quyền Student cho thao tác đang yêu cầu.",
    RATE_LIMITED: "Đã vượt ngưỡng đăng nhập. Chờ hết thời gian Retry-After rồi thử lại.",
    STALE_CHAIN_STATE: "Chưa xác minh được trạng thái Library mới nhất. Thử lại sau khi chain đồng bộ.",
    RPC_UNAVAILABLE: "Không đọc được trạng thái Library từ chain. Thử lại khi RPC hoạt động.",
    CONFIGURATION_ERROR: "Library auth hoặc chain chưa được cấu hình đầy đủ.",
    SESSION_UNAVAILABLE: "Không đọc được session Library. Kiểm tra kết nối rồi thử lại.",
    INVALID_RESPONSE: "Backend trả dữ liệu session không hợp lệ. Chưa mở giao dịch.",
  } as Record<string, string>)[code] ?? "Chưa xác minh được quyền Library. Thử lại trước khi giao dịch.";
}
