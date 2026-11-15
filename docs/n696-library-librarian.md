# N-696719F4 — Thư viện Thủ thư

Trang `/staff/library` sử dụng session ví thư viện và API thật qua Next cùng origin. Tài khoản phải có role LIBRARIAN trong backend, ví kết nối phải khớp `roles.librarian` của deployment và mạng là 20261. Chỉ dùng tài khoản và dữ liệu demo.

## Chuẩn bị

1. Dùng Node 24 và pnpm theo lockfile. Cấu hình backend, manifest, catalog, ví demo và auth origin như `docs/library-backend.md`; RPC và manifest phải thuộc cùng deployment.
2. Đặt `BACKEND_URL` cho Next và `NEXT_PUBLIC_INTRACAMPUS_RPC_URL` cho trình duyệt. Với Anvil cô lập, dùng `NEXT_PUBLIC_ALLOW_LOCAL_ANVIL=true` và RPC HTTP loopback. Không sử dụng khóa hoặc dữ liệu sinh viên thật.
3. Chạy `pnpm dev`, mở `/staff/library`, kết nối ví thủ thư được cấu hình, chọn mạng 20261 và ký đăng nhập. Chữ ký đăng nhập không chuyển tiền.

## Quy trình demo

1. Sinh viên tạo yêu cầu và nộp cọc tại `/student/library`. Thủ thư làm mới hàng chờ, xem sách, người mượn, cọc và hạn duyệt.
2. Chọn **Duyệt** hoặc **Từ chối**, kiểm tra ví ký, mạng, escrow, request và người nhận trước khi xác nhận trong ví. Chỉ event đã được API xác minh mới xác nhận kết quả. Sinh viên làm mới trang để xem trạng thái tương ứng.
3. Khi sách được trả, kiểm tra đã nhận sách vật lý rồi chọn **Xác nhận nhận sách**. Sau proof, chọn **Quyết toán trả**, nhập tình trạng, phí sửa chữa nếu có và lý do; kiểm tra breakdown do server cung cấp trước khi ký.
4. Với sách chưa nhận lại, chọn **Báo mất**, nhập lý do và kiểm tra preview giá thay thế, hoàn cọc và phần thiếu trước khi ký. Sinh viên thanh toán phần thiếu bằng ví của mình nếu có.

## Recovery

Khi ví hoặc RPC không trả kết quả rõ ràng, giữ nguyên journal và dùng chức năng đối chiếu; có thể cần hash trong lịch sử ví. Request đã rời hàng chờ vẫn có thể xuất hiện trong vùng recovery. Không gửi lại khi giao dịch còn unknown hoặc pending. Chỉ coi giao dịch hoàn tất khi API xác minh receipt và event khớp. Nếu đổi ví, đăng nhập lại bằng ví thủ thư trước khi xử lý tiếp.

## Pilot cô lập

Theo `docs/n471-library-student.md`, tạo bản sao source mới dưới đường dẫn chứa `.cross-review`, không copy `.env`, database, `node_modules` hoặc build cũ. Cài dependencies; chuẩn bị artifacts Foundry và thư mục package Playwright. Dùng một Anvil riêng chain 20261 trên cổng loopback trống và đảm bảo cổng Next 3129 đang trống.

```powershell
$env:LIBRARY_PILOT_ISOLATED='true'
$env:LIBRARY_ANVIL_URL='http://127.0.0.1:<cong-anvil-rieng>'
node frontend/test/library-student-pilot.mjs <pilot-copy> <contracts-out-dir> <playwright-package-dir>
```

Pilot dùng browser provider fixture, Next, Express, SQLite mới và Anvil riêng. Script đóng browser, Next và API; người chạy dừng Anvil riêng sau lượt chạy. Xem evidence JSON và ảnh 390px/1280px cạnh bản sao; không lưu bí mật vào evidence. Kết quả này là kiểm thử local, không chứng minh ví Core extension hoặc Avalanche L1. N-75 vẫn cần nghiệm thu tích hợp riêng.
