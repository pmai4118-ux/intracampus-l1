import { librarySessionMessage } from './library-session.ts';
export const libraryLabels: Record<string, string> = {
  AWAITING_DEPOSIT: 'Chờ nộp cọc', PENDING_APPROVAL: 'Đã cọc · chờ thủ thư duyệt', REJECTED_NO_COPY: 'Hết bản · chờ hoàn cọc',
  REJECTED: 'Đã từ chối', EXPIRED_REFUND_DUE: 'Hết hạn duyệt · có thể nhận lại cọc', APPROVED: 'Đã duyệt mượn',
  ACTIVE: 'Đang mượn', RETURN_REQUESTED: 'Đã yêu cầu trả', SETTLEMENT_PENDING: 'Thủ thư đã nhận · chờ quyết toán',
  RETURNED: 'Đã trả và quyết toán', LOST_SHORTFALL_DUE: 'Sách mất · cần thanh toán phần thiếu', LOST_SETTLED: 'Đã tất toán sách mất',
  NONE: 'Chưa phát sinh', REFUND_DUE: 'Chưa hoàn cọc', REFUNDED: 'Đã hoàn cọc', UNKNOWN: 'Chưa rõ kết quả',
  SUBMITTED: 'Đang chờ xác minh', CONFIRMED: 'Đã xác minh', REVERTED: 'Giao dịch thất bại',
  deposit: 'Nộp cọc', refund: 'Nhận lại cọc hết hạn', payShortfall: 'Thanh toán phần thiếu',
  approve: 'Duyệt mượn', reject: 'Từ chối yêu cầu', confirmReturn: 'Xác nhận nhận sách', return: 'Quyết toán trả sách', settle: 'Quyết toán sách mất',
};
export function libraryError(error: unknown): string {
  const e = error as { code?: string; retryAfterSeconds?: number };
  const message: Record<string, string> = {
    STORAGE_BLOCKED: 'Không lưu/đọc được nhật ký. Giữ request ID và hash; đối chiếu trước khi ký thêm.',
    RECOVERY_REQUIRED: 'Lượt trước chưa rõ kết quả. Đối chiếu giao dịch trước khi ký thêm.',
    ACTION_UNAVAILABLE: 'Trạng thái đã thay đổi hoặc thao tác chưa đến hạn. Làm mới để kiểm tra.',
    INTENT_MISMATCH: 'Thông tin giao dịch không khớp cấu hình thư viện. Chưa gửi giao dịch.',
    INVALID_HASH: 'Nhập hash giao dịch gồm 0x và 64 ký tự hex từ ví.',
    WALLET_REQUEST_PENDING: 'Đang có yêu cầu mở trong ví. Hoàn tất yêu cầu đó trước.',
    SIGNATURE_REJECTED: 'Bạn đã từ chối ký đăng nhập. Có thể thử lại.',
    USER_REJECTED: 'Bạn đã từ chối giao dịch. Chưa gửi tiền.',
    SEND_OUTCOME_UNKNOWN: 'Chưa rõ ví đã gửi giao dịch hay chưa. Kiểm tra lịch sử ví và đối chiếu.',
    LOCK_UNAVAILABLE: 'Trình duyệt chưa hỗ trợ khóa giao dịch an toàn. Mở bằng HTTPS hoặc localhost trong trình duyệt có Web Locks.',
    CONFLICT: 'Yêu cầu xung đột với tồn kho hoặc trạng thái mới. Làm mới trước khi thử tiếp.',
    NOT_FOUND: 'Không tìm thấy yêu cầu thuộc tài khoản này.',
  };
  const code = e?.code ?? 'RPC_UNAVAILABLE';
  return `${message[code] ?? librarySessionMessage(code)}${e?.retryAfterSeconds ? ` Thử lại sau ${e.retryAfterSeconds} giây.` : ''}`;
}
export function libraryDate(seconds: number | null) { return seconds === null ? 'Chưa có' : new Date(seconds * 1000).toLocaleString('vi-VN'); }
