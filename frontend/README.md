# U01 · Khung Student và Merchant POS

Hai trang dùng chung fixture ở `app/demo-fixtures.ts`. Bản xem thử dùng tông sáng, xanh lá và không cần RPC hay ví.

## Xem trên máy

Từ thư mục gốc, dùng Node.js 24 và pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm --filter @intracampus/frontend dev
```

- Student: <http://127.0.0.1:3000/student>, kiểm tra ở viewport 390 × 844 px.
- POS: <http://127.0.0.1:3000/pos>, kiểm tra ở viewport 1440 × 1000 px.
- Mở **Thử các trạng thái màn hình** để đổi giữa hóa đơn, đang tải, chờ ký, chờ xác nhận, lỗi và biên lai mẫu; chọn tài khoản có thẻ hoặc không có thẻ.

## Các thao tác cần kiểm tra

1. Student hiển thị giá gốc 3.000 CAMPUS; tài khoản có thẻ giảm 300, còn 2.700 CAMPUS. Phí gas mẫu được tách riêng.
2. Bấm **Thử bước ký**, kiểm tra số tiền, địa chỉ nhận và mạng; thử đồng ý/từ chối ký. Chờ xác nhận chưa hiển thị biên lai; chỉ **Xem biên lai mẫu** mới mở biên lai giả lập.
3. Tại POS, sao chép phiếu mẫu rồi dán vào Student. JSON lỗi hoặc thay đổi trường trong fixture khóa nút thử ký; **Lấy lại phiếu mẫu** khôi phục dữ liệu. Đây là đối chiếu fixture, chưa phải xác minh chữ ký EIP-712.
4. Thử lỗi hết hạn, sai chain, RPC không truy cập được, từ chối ký và nội dung không hợp lệ. Mỗi lỗi có hướng tiếp tục. Lỗi RPC không khẳng định tiền đã hoặc chưa bị trừ.
5. Chỉ hiện sao chép thành công khi Clipboard API thực sự thành công. Khi trình duyệt từ chối, giao diện hướng dẫn chọn và chép nội dung thủ công.

## Phạm vi và điểm nối

- `U02`: thay tài khoản/số dư/thẻ/mạng mẫu bằng dữ liệu ví và chain.
- `U03` + `B01`: thay vùng QR bằng mã QR thật, tạo hóa đơn mới, đồng hồ hết hạn và xác minh payload/chữ ký. Phiếu U01 có mốc thời gian cố định, không dùng để thanh toán thật. Nút đặt lại luôn dùng cùng fixture, không phát hành invoice mới.
- `U04` + `B04`: thay bộ chọn trạng thái bằng vòng đời giao dịch và receipt/event đã xác minh; đồng bộ hai thiết bị qua API. Hiện hai trang chỉ dùng cùng dữ liệu mẫu, không tự đồng bộ trạng thái.

## Kết quả kiểm tra tại máy

Ngày 08/11/2026, Node.js 24.22.2:

- `pnpm typecheck`, `pnpm test` (3 API), `pnpm test:rpc` (18), `pnpm build`: đạt.
- Chạy typecheck và build tuần tự vì cả hai sử dụng kiểu route sinh trong `.next/`.
- Edge/Chromium: 6 trạng thái ở 320, 390, 768, 1024, 1440 px, không tràn ngang. Nút Student nằm trong viewport 390 × 844 px ngay khi mở trang.
- Đã thử từ chối ký, pending chưa có biên lai, hai mức giá, payload sai/đã sửa, cùng invoice ở hai trang và hai nhánh sao chép thành công/thất bại. Không có lỗi console/page trong lượt kiểm tra cuối.
- Kiểm tra số nguyên: mức giảm làm tròn xuống và tổng tiền biên lai; định dạng giữ chính xác cả 1 wei.
- Ảnh và báo cáo trình duyệt ở [`../artifacts/u01/`](../artifacts/u01/): `student-390.png`, `student-rejected-390.png`, `student-receipt-390.png`, `pos-desktop.png`, `pos-error-desktop.png`, `pos-receipt-desktop.png`, `qa-report.json`.

Đây là kiểm tra fixture trên trình duyệt desktop với viewport mô phỏng, chưa phải thử trên điện thoại vật lý hoặc L1 thật. Nghiệm thu U01 cần một thành viên khác review theo AGENTS.md.
