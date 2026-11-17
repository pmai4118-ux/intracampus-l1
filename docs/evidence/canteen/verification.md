## Kiểm tra 2026-11-17

- `pnpm typecheck`: backend/frontend qua.
- `pnpm test`: 572 pass; 2 bài Anvil thư viện có sẵn bị skip theo cấu hình suite. Không có test thất bại.
- `pnpm build`: production build có route `/student/canteen`.
- `node backend/test/canteen-local.ts http://127.0.0.1:18639 <contracts-dir> docs/evidence/canteen/anvil.json`: qua với contract đã đối chiếu source; hai hash ở `anvil.json` thuộc Anvil riêng, không phải L1.
- Browser tại cổng 3119: đọc 3 món từ API, chọn cơm tấm ×2 thành 2.000 CAMPUS; đổi nguồn sang FOOD cập nhật thông báo gas. Chưa có kiểm thử ví Core thật trong browser.

Giới hạn: không có nghiệm thu Avalanche L1 hoặc hai thiết bị thật. Cần manifest, RPC mới, signer invoice và phiên auth cùng cấu hình trước khi dùng luồng ký thực tế. Bản worktree không chứa `.env` hoặc khóa ví được sao chép từ checkout chính.

Review độc lập `review-impl-20261117-001`: APPROVE ở vòng 2. Đã sửa trạng thái EXPIRED thay cho chờ vô hạn và loại bỏ quét RPC khi tải toàn bộ lịch sử. Reviewer chạy lại đủ typecheck, test và build; không còn finding.
