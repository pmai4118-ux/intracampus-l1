# Nhật ký quyết định

Thêm một mục khi đổi giao kèo dùng chung, cấu hình chain, dependency quan trọng hoặc quy trình làm việc. Mỗi mục ghi mã task nếu có, quyết định, lý do và module bị ảnh hưởng. Khi thay thế quyết định cũ, ghi rõ mục nào được thay thế.

## D001 · Quy trình làm việc với bảng sprint và AI · 2026-11-07

`AGENTS.md` là nguồn hướng dẫn chung. Các file theo công cụ chỉ dẫn agent đến file này. Tiêu đề PR dùng `[MÃ TASK]` để bảng sprint liên kết PR. Thành viên chịu trách nhiệm review và nghiệm thu trên bảng.

## D002 · Đồng bộ trạng thái PR với bảng sprint · 2026-11-07

Workflow `Sprint board PR sync` dùng quyền đọc PR của GitHub Actions để gửi số PR, mã task và trạng thái sang Sites sau khi PR vào `main` thay đổi. Sites xác minh token OIDC gắn với workflow trên `main`. Chỉ thành viên đã đăng ký trên bảng xem được feed. Quyền mở nội dung PR do GitHub kiểm soát.

Lần chạy đầu gửi danh sách hiện có. Có thể chọn **Run workflow** trên `main` để đồng bộ lại. Nhật ký Actions báo số PR có mã đã gửi. Bảng lưu bản đồng bộ gần nhất và hiển thị thời điểm nhận dữ liệu.
