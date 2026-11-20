import type { CampusProfile, CampusPayout } from "@intracampus/network";
import { isWalletAddress } from "./chains.ts";
export type CampusMe = { wallet: string; school: boolean; profile: CampusProfile };
export async function campusApi(path: string, body?: unknown) {
  const response = await fetch(`/api/campus/${path}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10000),
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.code ?? "SERVICE_UNAVAILABLE"); return data;
}
export async function campusMe(expected: string): Promise<CampusMe> {
  const result = await campusApi("me");
  if (!isWalletAddress(result.wallet) || result.wallet.toLowerCase() !== expected.toLowerCase()) throw Error("WALLET_SESSION_CHANGED");
  if (typeof result.school !== "boolean" || !result.profile || !Array.isArray(result.profile.payouts)) throw Error("INVALID_RESPONSE");
  return result;
}
export async function campusLogin(wallet: string, sign: (wallet: string, message: string) => Promise<string>): Promise<CampusMe> {
  const challenge = await campusApi("auth/challenge", { wallet });
  if (typeof challenge.challengeId !== "string" || typeof challenge.message !== "string" || !Number.isSafeInteger(challenge.expiresAt) || challenge.expiresAt * 1000 <= Date.now()) throw Error("INVALID_RESPONSE");
  const signature = await sign(wallet, challenge.message);
  await campusApi("auth/verify", { challengeId: challenge.challengeId, signature });
  return campusMe(wallet);
}
export function validateCampusPayout(p: CampusPayout, account: string) {
  if (!p || !isWalletAddress(p.from) || p.from.toLowerCase() !== account.toLowerCase() || !isWalletAddress(p.to) || !isWalletAddress(p.wallet)
    || !["WELCOME", "SCHOLARSHIP"].includes(p.kind) || !/^0x(?:[0-9a-f]{2})+$/i.test(p.data) || !/^0x[1-9a-f][0-9a-f]*$/i.test(p.value)
    || BigInt(p.value) >= BigInt(2) ** BigInt(256)
    || (p.kind === "WELCOME" && (BigInt(p.value) !== BigInt(20) * BigInt(10) ** BigInt(18) || p.to.toLowerCase() !== p.wallet.toLowerCase()))) throw Error("INVALID_RESPONSE");
  return { to: p.to, data: p.data, value: p.value };
}
export const campusStatus = { PENDING: "Chờ nhà trường duyệt", APPROVED: "Đã được duyệt", REJECTED: "Cần bổ sung hồ sơ", PREPARED: "Sẵn sàng cấp", UNKNOWN: "Cần đối chiếu kết quả", FAILED: "Giao dịch thất bại · chưa cấp tiền", CONFIRMED: "Đã xác minh giao dịch" };
export function campusMessage(code: string) {
  return ({ UNAUTHENTICATED: "Đăng nhập bằng ví để tiếp tục.", WALLET_SESSION_CHANGED: "Ví hiện tại khác phiên đăng nhập. Hãy đăng nhập lại.",
    SCHOOL_ONLY: "Ví này chưa được nhà trường phân quyền duyệt hồ sơ.", CONFIGURATION_ERROR: "Cổng xác minh chưa được cấu hình. Liên hệ người phụ trách.",
    DEPLOYMENT_NOT_CONFIGURED: "Chưa có bản triển khai học bổng đã xác minh để giải ngân.", STUDENT_NOT_VERIFIED: "Hồ sơ sinh viên cần được nhà trường duyệt trước.",
    SCHOLARSHIP_NOT_APPROVED: "Học bổng chưa được duyệt.", STUDENT_ID_ALREADY_VERIFIED: "Mã sinh viên đã được xác nhận cho ví khác. Cần nhà trường đối chiếu lại.",
    ALREADY_REVIEWED: "Hồ sơ đã được xử lý. Tải lại danh sách để xem kết quả.", APPLICATION_LOCKED: "Hồ sơ đang chờ hoặc đã được duyệt; không thể sửa lúc này.",
    TREASURY_ONLY: "Chuyển sang ví quỹ nhà trường để cấp CAMPUS.", GRANT_ISSUER_ONLY: "Chuyển sang ví có quyền cấp học bổng.", PAYOUT_LOCKED: "Lượt cấp đã bắt đầu. Đối chiếu hash cũ, không gửi thêm.",
    RECEIPT_MISMATCH: "Giao dịch chưa khớp lượt cấp. Giữ hash và nhờ người vận hành đối chiếu; chưa cấp lại.", HASH_ALREADY_ATTACHED: "Lượt cấp đã gắn một hash. Tiếp tục đối chiếu hash đó.",
    WRONG_CHAIN: "Chuyển ví và RPC sang IntraCampus L1 (20261).", STALE_CHAIN_STATE: "Dữ liệu mạng chưa đủ mới. Chưa mở giao dịch.", INVALID_REQUEST: "Kiểm tra lại mã sinh viên và thông tin đã nhập.",
    RPC_UNAVAILABLE: "Chưa đọc được mạng. Giữ hash và thử đối chiếu lại.", RATE_LIMITED: "Bạn thao tác quá nhanh. Đợi một phút rồi thử lại." } as Record<string, string>)[code] ?? "Chưa hoàn tất thao tác. Kiểm tra kết nối, ví và thử lại; không gửi lại khoản cấp chưa rõ kết quả.";
}
