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
