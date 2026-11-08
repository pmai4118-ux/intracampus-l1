# Nhật ký quyết định

Thêm một mục khi đổi giao kèo dùng chung, cấu hình chain, dependency quan trọng hoặc quy trình làm việc. Mỗi mục ghi mã task nếu có, quyết định, lý do và module bị ảnh hưởng. Khi thay thế quyết định cũ, ghi rõ mục nào được thay thế.

## D001 · Quy trình làm việc với bảng sprint và AI · 2026-11-07

`AGENTS.md` là nguồn hướng dẫn chung. Các file theo công cụ chỉ dẫn agent đến file này. Tiêu đề PR dùng `[MÃ TASK]` để bảng sprint liên kết PR. Thành viên chịu trách nhiệm review và nghiệm thu trên bảng.

## D002 · Đồng bộ trạng thái PR với bảng sprint · 2026-11-07

Workflow `Sprint board PR sync` dùng quyền đọc PR của GitHub Actions để gửi số PR, mã task và trạng thái sang Sites sau khi PR vào `main` thay đổi. Sites xác minh token OIDC gắn với workflow trên `main`. Chỉ thành viên đã đăng ký trên bảng xem được feed. Quyền mở nội dung PR do GitHub kiểm soát.

Lần chạy đầu gửi danh sách hiện có. Có thể chọn **Run workflow** trên `main` để đồng bộ lại. Nhật ký Actions báo số PR có mã đã gửi. Bảng lưu bản đồng bộ gần nhất và hiển thị thời điểm nhận dữ liệu.

## D003 · Chia backend theo nghiệp vụ · 2026-11-08

Backend MVP dùng một ứng dụng Express với router và service theo module. Hóa đơn và xác minh receipt nằm cùng module `invoices` vì đều cập nhật vòng đời của một hóa đơn. Cách này giúp nhóm triển khai API trong một tiến trình và xác định rõ nơi sửa khi làm các task POS. Xem [kiến trúc backend](../backend/README.md) để tra đường dẫn theo mã task.

## D004 · P01: đề xuất phạm vi và kịch bản demo · 2026-11-08

Tạo [phạm vi MVP](scope.md) và [kịch bản hai thiết bị](demo-flow.md) để frontend, backend, contracts và hạ tầng cùng triển khai luồng bãi xe QR → ví → biên nhận. Thanh toán là luồng ưu tiên đầu tiên; học bổng giới hạn merchant và Copilot chỉ đọc vẫn thuộc MVP theo bảng sprint. Các task X để sau mốc MVP.

Người giao việc xác nhận nhóm ba người có thể luân phiên giữa các mảng. Mỗi task cần một người làm và một reviewer khác; tên người phụ trách được nhận trên sprint theo từng lượt, không cố định theo module. P01 không nhận task hoặc đổi trạng thái sprint thay cho nhóm.

Hai tài liệu hiện là bản đề xuất chờ cả nhóm review. Mức giảm, thời hạn invoice và dữ liệu seed là đề xuất cần chốt với P02 và người nhận task contract/backend; mục này không xác nhận nhóm đã duyệt, không chốt ABI/API, và không ghi nhận đã chạy L1.

## D005 · L01: Genesis và mạng Avalanche local · 2026-11-08

Mạng thử nghiệm dùng Subnet-EVM với chain ID `20261`, đồng gốc `CAMPUS` (18 chữ số thập phân) và Proof of Authority. Cấu hình mạng dùng chung, backend và alias Foundry tiếp tục dùng cùng chain ID và RPC. [Genesis và runbook L01](../infra/README.md) ghi bộ phiên bản, cấu hình ví và cách kiểm tra phí.

Genesis cấp CAMPUS thử nghiệm cho địa chỉ công khai `ewoq`. L01 chỉ cần số dư genesis và chuyển đồng gốc, nên cấu hình hiện tại chưa bật Native Minter hay Fee Manager. L02 lấy RPC của blockchain này làm đích để chuẩn bị endpoint HTTPS cho thiết bị demo.

## D006 · L02: chuẩn bị gateway RPC cho tunnel HTTPS · 2026-11-08

[Runbook L02](../infra/rpc.md) dùng tunnel HTTPS trỏ tới gateway loopback trên máy giữ node L01 của hwng. Gateway chỉ chuyển tiếp JSON-RPC đã cho phép đến một đường blockchain cố định, kiểm tra chain `20261` khi khởi động, chặn các route/namespace quản trị và giới hạn batch/body/timeout. `/check` là trang kiểm tra chỉ đọc cho điện thoại, không phải dashboard node. Backend/frontend/ví dùng endpoint `/rpc`; không tunnel toàn bộ cổng node.

Thêm smoke script và test local để kiểm tra receipt, chain, CORS và việc chặn quản trị. Đây là phần chuẩn bị; chưa có endpoint HTTPS hoạt động hoặc kết quả từ điện thoại. Cần chủ máy chạy gateway/tunnel, ghi bằng chứng Wi-Fi/4G và endpoint dự phòng trước khi nghiệm thu. Không thay đổi genesis, ABI, schema P02 hoặc địa chỉ triển khai.

## D007 · P02: giao kèo hóa đơn EIP-712, payload QR tự chứa và mã lỗi API · 2026-11-08

Tạo [giao kèo hóa đơn EIP-712 và QR](invoice-contract.md) cùng [giao kèo HTTP API và mã lỗi](api-contract.md) để khóa dữ liệu dùng chung cho `L04`, `B01`, `B02`, `B04`, `U03`, `U04`:

- Miền EIP-712 dùng `name = "IntraCampusPayment"`, `version = "1"`, `chainId = 20261` và `verifyingContract` là địa chỉ `CampusPaymentRegistry`. Kiểu chính `Invoice(bytes32 invoiceId,address merchant,bytes32 category,uint256 amount,uint64 expiresAt)` có fixture đối chiếu `domainSeparator`, `structHash`, `digest`, chữ ký `ecrecover` và 3 mẫu sửa `amount`/`chainId`/`verifyingContract`.
- Chọn phương án QR tự chứa (`SignedInvoiceEnvelope` dạng JSON thu gọn trong `qrPayload`) để thiết bị sinh viên (`/student`) kiểm tra hạn, miền ký và chữ ký ngay sau khi quét hoặc dán mã mà không cần gọi thêm một vòng API về backend trước bước xem trước.
- Chốt ABI sự kiện `InvoicePaid`, quy tắc làm tròn xuống theo đơn vị `wei` cho mức giảm SBT `10%`, vòng đời trạng thái `pending` / `paid` / `expired` / `rpc-error` và bảng mã lỗi tiếng Việt dùng chung giữa `contracts/`, `backend/` và `frontend/`.

- Sau review P02, bổ sung getter `CampusPaymentRegistry.posSigner()` vào ABI đề xuất: đây là signer chung mà `payInvoice`, backend `B01` và frontend `U03` cùng đối chiếu. Địa chỉ verifier/signer tin cậy lấy từ bản triển khai `L06` hoặc getter trên đúng chain; lỗi tra cứu phải chặn mở ví. Thay đổi này bổ sung ABI đọc, giữ nguyên kiểu EIP-712, digest fixture và sự kiện `InvoicePaid`.
