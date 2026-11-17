# Làm mới giao diện IntraCampus

Ngày kiểm tra: 17/11/2026. Nhánh local: `codex/ui-campus-refresh`, dựa trên `main` tại `cc50b9c`.

Yêu cầu cải thiện UI chưa có mã task trên sprint. Phạm vi là ứng dụng trong repo này; website sprint được dùng để đọc yêu cầu. Chưa push, mở PR, deploy hoặc cập nhật bảng sprint.

## Giao diện đã thay đổi

- Trang chủ có phần giới thiệu, hình thẻ CAMPUS bằng CSS/SVG, ba lối vào dịch vụ và trạng thái RPC thực tế.
- Thanh điều hướng có biểu tượng, mục đang xem qua `aria-current`, liên kết Tổng quan và bố cục riêng cho màn hình hẹp.
- Trang sinh viên có hai cột trên desktop, một cột trên mobile; phân biệt ví, thanh toán QR và voucher FOOD.
- POS có vùng tạo/hiển thị hóa đơn, trạng thái thanh toán và khôi phục hóa đơn. Khi chưa tạo hóa đơn, vùng QR giải thích thao tác tiếp theo.
- Thư viện sinh viên và thủ thư dùng cùng tiêu đề, màu, biểu tượng và hệ thống nút. Quy chế được chia thành các mục dễ đọc.
- Giữ skip link, nhãn trường nhập, trạng thái disabled, focus bàn phím và hỗ trợ reduced motion. Nút chuyển chế độ có vùng bấm tối thiểu 44px. Trường nhập trên mobile dùng chữ 16px.

Các thành phần dùng chung nằm trong `frontend/app/components/`; lớp giao diện mới nằm trong `frontend/app/campus.css`. Không thêm dependency, font tải ngoài hoặc ảnh từ dịch vụ bên ngoài.

Logic ví, chữ ký, tiền theo wei, receipt, voucher và escrow không đổi. Dữ liệu chưa đọc được vẫn được ghi rõ là chưa xác minh; biên lai và số tiền trong chế độ minh họa vẫn có nhãn dữ liệu mẫu.

## Kiểm tra

| Kiểm tra | Kết quả |
| --- | --- |
| TypeScript frontend | Đạt |
| TypeScript backend | Đạt |
| Bộ test frontend trên Node.js 24.22.2 | 191 đạt, 0 lỗi, 0 skip |
| Next.js production build | Đạt |
| Browser: `/`, `/student`, `/pos`, `/student/library`, `/staff/library` | Đã mở trên dev và production |
| Responsive | 30 lượt quan sát bố cục, không phát hiện tràn ngang; viewport trải từ 320 đến 1440px |
| Điều hướng và cấu trúc tiêu đề | Mỗi trang một `h1`, đúng mục điều hướng đang chọn |
| Student demo | Đã thử bước ký, từ chối ký, biên lai mẫu và số tiền 2.700 CAMPUS |
| POS demo | Đã thử chờ ký → chờ xác nhận → biên lai mẫu |
| POS thiếu cấu hình L1 | Hiện lỗi API, không tạo thành công giả |
| Console trong lượt production cuối | Không có lỗi được ghi nhận |
| `git diff --check` | Đạt |

Frontend test tự chạy Next.js, nên cần dừng dev server của cùng checkout trước khi chạy test. Lượt chạy riêng đã qua toàn bộ; không bỏ qua test proxy/RPC.

Đây là kiểm tra UI, controller/API local và fixture. Chưa nghiệm thu ví Core, danh mục thư viện sau đăng nhập hoặc giao dịch trên L1 thật; các phần này cần RPC, manifest và ví demo của nhóm. Không thay cấu hình deployment để tạo dữ liệu giả.

## Chạy lại

Với Node.js 24 và pnpm 11.25.0, tại thư mục gốc:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Mở <http://127.0.0.1:3000>. Có thể chọn **Xem bản minh họa** trong trang sinh viên/POS để xem các trạng thái khi chưa kết nối ví.

Kiểm tra lại sau khi dừng dev server:

```sh
pnpm typecheck
pnpm --filter @intracampus/frontend test
pnpm build
```

Trong phiên làm việc này, máy có Node.js 26 mặc định. Các kiểm tra tự động cuối dùng binary Node.js 24.22.2 cục bộ trong thư mục `node_modules` bị Git bỏ qua; không đổi Node mặc định của máy. Các server dùng để kiểm tra đã được dừng sau khi chụp ảnh.

## Ảnh và bằng chứng

- [Trang chủ desktop](../artifacts/ui-refresh/home-desktop.jpg) · [mobile](../artifacts/ui-refresh/home-mobile.jpg).
- [Sinh viên desktop](../artifacts/ui-refresh/student-desktop.jpg) · [mobile](../artifacts/ui-refresh/student-mobile.jpg).
- [POS desktop](../artifacts/ui-refresh/pos-desktop.jpg).
- [Thư viện sinh viên](../artifacts/ui-refresh/library-desktop.jpg) · [thủ thư](../artifacts/ui-refresh/staff-desktop.jpg).
- [Biên lai minh họa trên mobile](../artifacts/ui-refresh/student-demo-receipt-mobile.jpg).
- [Báo cáo bố cục](../artifacts/ui-refresh/browser-checks.json), [log test](../artifacts/ui-refresh/frontend-tests.txt), [log build](../artifacts/ui-refresh/build.txt).
