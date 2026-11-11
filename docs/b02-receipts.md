# B02 · Đọc receipt và cập nhật trạng thái POS

Phạm vi: backend GET lookup, xác minh `InvoicePaid`, SQLite lưu dữ liệu qua restart và bảo vệ polling khi RPC lỗi. Nguồn giao kèo: [P02 API](api-contract.md), [ABI InvoicePaid](invoice-contract.md). Các type JSON dùng chung được export từ `@intracampus/network` để B04/U04 dùng lại.

## Bảng trạng thái

| Kết quả | HTTP / status | Transaction và lưu trữ |
| --- | --- | --- |
| Chưa có thanh toán, timestamp block `<= expiresAt` | 200 / pending | Giữ hash unverified nếu có |
| Chưa có thanh toán, timestamp block `> expiresAt` | 200 / expired | Hash unverified tiếp tục được đối chiếu |
| Receipt thành công và event khớp mọi điều kiện P02 | 200 / paid | Commit receipt + confirmed trước khi phản hồi |
| Receipt-null | 200 / pending hoặc expired | unverified; không kết luận thất bại |
| Receipt revert | 422 / pending hoặc expired | reverted + TX_REVERTED |
| Receipt thành công, event không khớp | 422 / pending hoặc expired | event-mismatch + RECEIPT_EVENT_MISMATCH |
| RPC lỗi/sai chain hoặc dữ liệu chưa đủ để đối chiếu | 503 / rpc-error | Giữ lastKnownStatus, updatedAt và hash; Retry-After |
| Đã có receipt xác minh rồi RPC mất kết nối hoặc TTL hết | 200 / paid | Trả receipt đã commit, không phát log thanh toán mới |
| Kho dữ liệu lỗi | 500 / error INTERNAL_ERROR | Không trả paid trước khi commit; không xuất thông tin lỗi nội bộ |

## Bằng chứng tái tạo

`pnpm --filter @intracampus/backend test:b02:evidence` chạy chuỗi pending → RPC lỗi → paid → GET lặp khi RPC lỗi bằng SQLite tạm và RPC giả lập. [Log lưu sẵn](b02-evidence.jsonl) có một `invoice_paid`, hai lần trả paid và một lỗi 503. [Raw receipt fixture](fixtures/b02-receipt-fixture.json) dùng số liệu tổng hợp từ P02, không phải giao dịch thật. Thời gian fixture được cố định để tái tạo kết quả.

Test implementation bao phủ ABI lỗi, contract/invoice/merchant/category sai, tier 0/1/2/255, số tiền uint256 và làm tròn wei, timestamp chain, receipt-null, revert, hash gợi ý sai, RPC lỗi trước/sau hash, scan theo khoảng và rewind khi log thiếu, paid đọc sau hạn, poll đồng thời, restart SQLite và lỗi commit. Test HTTP chạy từ Express qua JSON-RPC loopback; không gửi giao dịch.

Kiểm tra cục bộ ngày 11/11/2026: `pnpm typecheck`, `pnpm test`, `pnpm build` và script evidence đều đạt trên Node 24.22.1/pnpm 11.25.0. Build kiểm tra frontend hiện có cùng package type mới; không phải nghiệm thu luồng POS bằng trình duyệt. Chưa có reviewer độc lập hoặc kết quả L1 cho B02.

## Điểm nối còn lại

- B01 lưu envelope vào cùng `InvoiceRepository` trước khi trả hóa đơn. Giữ quyền ký và việc tạo invoice trong B01; B02 không có public POST nhập dữ liệu.
- L06 bàn giao verifier và deployment block thật; L02 cung cấp RPC đã xác minh bằng `pnpm rpc:check`. B02 hiện chỉ có bằng chứng fixture/HTTP giả lập; chưa nghiệm thu L1 thật.
- B04 nối API với invoice/POS thật. U04 thực hiện timer poll/backoff và khử thông báo lặp theo event key. API thêm `Retry-After` cho 503 và `INTERNAL_ERROR` 500; các response vòng đời P02 giữ nguyên.
- SQLite này phù hợp backend chạy trên một host với volume bền vững. Triển khai nhiều replica cần dùng cùng kho transactional được quản lý, chính sách finality/reorg của mạng và giám sát vận hành; B02 không xác nhận sẵn sàng production.

Không đổi trạng thái bảng sprint hoặc nghiệm thu thay thành viên khác. PR cần CI và một đồng đội review theo AGENTS.md.
