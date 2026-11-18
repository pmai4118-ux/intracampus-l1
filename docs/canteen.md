# Nhà ăn: đặt món và thanh toán

MVP: `/student/canteen`, menu SQLite được seed với cơm tấm 1.000, phở bò 1.200, bún bò 1.500 CAMPUS. Đây là giá demo. Một đơn chọn WALLET hoặc FOOD; tổng và giá từng món được snapshot server-side. Không có trạng thái bếp.

`CANTEEN_DB_PATH` mặc định `backend/data/canteen.sqlite`. Chạy `pnpm --filter @intracampus/backend seed:canteen` trước khi dùng. Seed chạy lại không sửa giá hoặc đơn đã có. Backup SQLite nhất quán; không xóa DB để reset giao dịch.

API `/api/canteen/menu`, `/api/canteen/orders`, `/api/canteen/orders/:id/prepare`, `/api/canteen/orders/:id/transactions`. Đơn thuộc ví trong phiên auth hiện có; mutations yêu cầu Origin đúng cấu hình và tài khoản không bị hold. Đối chiếu đơn đã gửi vẫn được phép khi bị hold.

Thanh toán WALLET dùng invoice EIP-712 và quy tắc SBT hiện tại (tier 1 giảm 10%). FOOD dùng đúng tổng đơn, sinh viên vẫn cần CAMPUS trong ví cho gas. Merchant, vault, registry lấy từ manifest L06. Không có sửa ABI hoặc triển khai contract mới.

Vault FOOD không có orderId trên chain. DB dành riêng một hash cho một đơn; verifier kiểm tra giao dịch trực tiếp từ ví tới vault, calldata spend, amount, merchant FOOD và block sau prepare. Đây là liên kết off-chain; không cung cấp bảo đảm chống sinh viên tự trả lặp ngoài app. Client giữ nhật ký trước khi yêu cầu ví, kết quả chưa rõ chỉ được tra lại hoặc nhập hash từ lịch sử ví. Không tự gửi lại.

Không hỗ trợ đổi phương thức, chia nguồn tiền, hủy hoặc hoàn đơn trong MVP. Giao dịch revert hoặc nhập nhầm hash giữ nguyên bằng chứng và cần operator đối chiếu; không tự xóa hash. Chưa xác minh RPC thì không báo đã trả.

Invoice ví có TTL 300 giây theo luồng B01. Đơn chưa gửi mà hóa đơn đã hết hạn cần tạo đơn mới; đơn cũ giữ lịch sử. Không xoay invoiceId hoặc phát hành lại chữ ký cho đơn cũ. Với giao dịch chưa rõ kết quả, đối chiếu trước, không tạo khoản trả lại. Backend tự tìm receipt WALLET khi mở/đối chiếu đơn để khôi phục lần cập nhật bị mất.

Đơn WALLET chưa có hash và được RPC xác minh hết hạn chuyển sang EXPIRED. Lịch sử đọc từ SQLite, không tự quét RPC từng đơn. Mở đơn thực hiện đối chiếu receipt; bằng chứng đã trả hợp lệ vẫn có thể chuyển EXPIRED sang PAID.

Khi mở lại đơn WALLET, `/prepare` đối chiếu invoice hiện có trước khi áp dụng hold cho việc chuẩn bị thanh toán mới. Đơn đã xác minh PAID hoặc EXPIRED trả kết quả cuối với `envelope: null`; thao tác này không tạo invoice hoặc TTL mới. Đơn chưa có bằng chứng thanh toán vẫn bị chặn bởi hold. Chủ đơn cần giữ phiên ví và Origin hợp lệ, không gửi lại giao dịch để làm mới trạng thái.

Regression HTTP nằm trong `backend/test/canteen-recovery.test.ts`. Script `backend/test/canteen-local.ts` kiểm tra thêm ca thanh toán Anvil thành công nhưng mất cập nhật hash, rồi mở lại khi held. Trong ca này auth và cờ held là fixture; receipt, invoice và giao dịch là dữ liệu EVM thật. API đối chiếu không làm tăng nonce ví hoặc số invoice được tạo.
