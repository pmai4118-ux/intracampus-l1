# Làm mới giao diện IntraCampus

Ngày kiểm tra cuối: 18/11/2026. Nhánh: `codex/ui-campus-refresh`, dựa trên nhánh nhà ăn `codex/canteen-ordering` tại `d614ff74c7714b75b85e4b792de357c496b62650`.

Yêu cầu cải thiện UI chưa có mã task trên sprint. Phạm vi là ứng dụng trong repo này; website sprint được dùng để đọc yêu cầu. Bản UI bao gồm phần nhà ăn mới của nhóm. PR dựa trên nhánh nhà ăn để reviewer chỉ xem diff UI; sau khi nhánh nhà ăn vào `main`, đổi base PR về `main`. Không merge, deploy hoặc cập nhật bảng sprint trong task này.

## Giao diện đã thay đổi

- Trang chủ có phần giới thiệu, hình thẻ CAMPUS bằng CSS/SVG, bốn lối vào dịch vụ và trạng thái RPC thực tế.
- Thanh điều hướng có biểu tượng, mục đang xem qua `aria-current`, liên kết Tổng quan và bố cục riêng cho màn hình hẹp.
- Trang sinh viên có hai cột trên desktop, một cột trên mobile; phân biệt ví, thanh toán QR và voucher FOOD.
- Nhà ăn có thẻ món ăn, nút tăng/giảm và nhập số lượng, chi tiết giỏ hàng, tổng tiền, nguồn CAMPUS/FOOD và lịch sử đơn. Có trạng thái đang tải, lỗi tải và tải lại thực đơn. Giá và món lấy từ API của nhánh nhà ăn, không thay bằng dữ liệu frontend giả lập.
- POS có vùng tạo/hiển thị hóa đơn, trạng thái thanh toán và khôi phục hóa đơn. Khi chưa tạo hóa đơn, vùng QR giải thích thao tác tiếp theo.
- Thư viện sinh viên và thủ thư dùng cùng tiêu đề, màu, biểu tượng và hệ thống nút. Quy chế được chia thành các mục dễ đọc.
- Giữ skip link, nhãn trường nhập, trạng thái disabled, focus bàn phím và hỗ trợ reduced motion. Nút chuyển chế độ có vùng bấm tối thiểu 44px. Trường nhập trên mobile dùng chữ 16px.

Các thành phần dùng chung nằm trong `frontend/app/components/`; lớp giao diện mới nằm trong `frontend/app/campus.css`. Không thêm dependency, font tải ngoài hoặc ảnh từ dịch vụ bên ngoài.

So với nhánh nhà ăn, logic ví, chữ ký, tiền theo wei, receipt, voucher và escrow không đổi. Không sửa backend, contract, API hoặc package mạng của nhánh đó. Dữ liệu chưa đọc được vẫn được ghi rõ là chưa xác minh; biên lai và số tiền trong chế độ minh họa vẫn có nhãn dữ liệu mẫu.

## Kiểm tra

| Kiểm tra | Kết quả |
| --- | --- |
| TypeScript frontend | Đạt |
| TypeScript backend | Đạt |
| Bộ test frontend trên Node.js 24.22.2 | 192 đạt, 0 lỗi, 0 skip |
| Bộ test backend trên Node.js 24.22.2 | 291 đạt, 0 lỗi; 2 bài Anvil thư viện có sẵn bị skip theo cấu hình |
| Next.js production build | Đạt |
| Browser production: `/`, `/student`, `/student/canteen`, `/pos`, `/student/library`, `/staff/library` | Cả sáu trang đã mở |
| Responsive | 28 lượt quan sát bố cục, không phát hiện tràn ngang; viewport trải từ 320 đến 1440px |
| Điều hướng và cấu trúc tiêu đề | Mỗi trang một `h1`, đúng mục điều hướng đang chọn |
| Student demo | Biên lai mẫu 2.700 CAMPUS hiển thị rõ nhãn minh họa |
| Nhà ăn: giỏ hàng | Cơm tấm ×2 = 2.000; cơm tấm ×1 + bún bò ×1 + phở bò ×2 = 4.900; xóa hết = 0 CAMPUS |
| Nhà ăn: nguồn thanh toán | Chọn FOOD giữ đúng tổng đơn và hiện thông báo gas từ ví |
| Nhà ăn: chưa đăng nhập | Nút tạo đơn bị khóa; không mở yêu cầu ký |
| Nhà ăn: phục hồi | Tắt API local → hiện lỗi tải; bật lại → nút tải lại khôi phục đủ 3 món mà không reload trang |
| Console | Không có lỗi trước ca tắt API có chủ đích; lỗi HTTP trong ca này là dự kiến |
| `git diff --check` | Đạt |

Frontend test tự chạy Next.js, nên cần dừng dev server của cùng checkout trước khi chạy test. Lượt chạy riêng đã qua toàn bộ; không bỏ qua test proxy/RPC.

Đây là kiểm tra UI, controller/API local và fixture. Thực đơn demo được seed qua script có sẵn, giữ đơn và giá đã tồn tại. Chưa nghiệm thu ví Core, đặt/thanh toán đơn sau đăng nhập, danh mục thư viện sau đăng nhập hoặc giao dịch trên L1 thật; các phần này cần RPC, manifest và ví demo của nhóm. Không thay cấu hình deployment để tạo dữ liệu giả.

## Chạy lại

Với Node.js 24 và pnpm 11.25.0, tại thư mục gốc:

```sh
pnpm install --frozen-lockfile
pnpm --filter @intracampus/backend seed:canteen
pnpm dev
```

Mở <http://127.0.0.1:3000>. Có thể chọn **Xem bản minh họa** trong trang sinh viên/POS để xem các trạng thái khi chưa kết nối ví.

Kiểm tra lại sau khi dừng dev server:

```sh
pnpm typecheck
pnpm --filter @intracampus/frontend test
pnpm --filter @intracampus/backend test
pnpm build
```

Trong phiên làm việc này, máy có Node.js 26 mặc định. Các kiểm tra tự động cuối dùng binary Node.js 24.22.2 cục bộ trong thư mục `node_modules` bị Git bỏ qua; không đổi Node mặc định của máy. Browser QA dùng web `3012` và API `4012` để tránh phiên local đang chiếm cổng mặc định; không commit các giá trị này vào cấu hình dự án. Các server QA được dừng sau khi chụp ảnh.

## Ảnh và bằng chứng

### Khắc phục review #28 trong bản local

Nhánh UI đã merge thông thường bản sửa nhà ăn `ea07c2ab180cecdc632b291e7b30af8c0305f836`. Khi mở lại đơn WALLET, backend đối chiếu receipt trước khi chặn việc chuẩn bị thanh toán mới do hold. [Giao kèo và regression nhà ăn](canteen.md) mô tả phạm vi.

Điều hướng ẩn nhãn mạng phụ và cho xuống hàng ở màn rộng tối đa 832px. Trên 576px đến 704px, sáu link chia thành hai hàng ba mục. Màn từ 576px trở xuống giữ thanh sáu biểu tượng hiện có. Không dùng cắt tràn ngang để che nội dung.

Regression browser kiểm tra đủ sáu link, label nằm trong viewport, active state, focus bàn phím và Back trên sáu trang với 11 độ rộng. Chạy khi server UI đã sẵn sàng, với Python Playwright và Chrome đã cài:

```sh
python frontend/test/navigation-browser.py --origin http://127.0.0.1:3158 --output artifacts/navigation-new-run
```

Output phải là thư mục mới. Có thể dùng `--channel msedge` khi kiểm tra bằng Edge. Bộ artifacts dưới đây giữ nguyên lượt bàn giao đầu; ảnh và log khắc phục mới được lưu cùng báo cáo `IntraCampus-L1-PR28-remediation.md` trên Desktop. Bản local chưa push hoặc thay đổi draft/base của PR.

- [Trang chủ desktop](../artifacts/ui-refresh/home-desktop.jpg) · [mobile](../artifacts/ui-refresh/home-mobile.jpg).
- [Sinh viên desktop](../artifacts/ui-refresh/student-desktop.jpg) · [mobile](../artifacts/ui-refresh/student-mobile.jpg).
- [Nhà ăn desktop](../artifacts/ui-refresh/canteen-desktop.jpg) · [mobile](../artifacts/ui-refresh/canteen-mobile.jpg).
- [POS desktop](../artifacts/ui-refresh/pos-desktop.jpg).
- [Thư viện sinh viên](../artifacts/ui-refresh/library-desktop.jpg) · [thủ thư](../artifacts/ui-refresh/staff-desktop.jpg).
- [Biên lai minh họa trên mobile](../artifacts/ui-refresh/student-demo-receipt-mobile.jpg).
- [Báo cáo bố cục và thao tác](../artifacts/ui-refresh/browser-checks.json), [test frontend](../artifacts/ui-refresh/frontend-tests.txt), [test backend](../artifacts/ui-refresh/backend-tests.txt), [log build](../artifacts/ui-refresh/build.txt).
