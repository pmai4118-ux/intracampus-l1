# U05 · Hiển thị và chi voucher FOOD

Student View hiển thị ngân sách FOOD từ API B05 và cho **chính ví beneficiary**
ký `PurposeBoundGrantVault.spend(canteen, FOOD, amountWei)` qua phiên Core U02/U04.
Số CAMPUS trong ví cá nhân dùng trả gas; khoản chi được lấy từ vault nên
`msg.value = 0`. Frontend không gọi `grant` và backend không chi thay sinh viên.

## Phụ thuộc

- U04 cung cấp `WalletController.sendTransaction(expectedAccount, transaction)`
  với kiểm tra lại tài khoản/mạng và phân loại kết quả gửi chưa rõ.
- L05/L06 đã có trên `main` `f6667b4`; manifest Git hiện vẫn `unconfigured`.
  Cần operator xuất deployment mạng demo thật, RPC 20261 và rebuild cả hai client.
  Manifest unconfigured hoặc local-anvil không bật nút chi production.
- B05 PR [#16](https://github.com/pmai4118-ux/intracampus-l1/pull/16) cung cấp
  `GET /api/grants/:beneficiary?txHash=...`, seed và xác minh receipt. Tại lúc
  triển khai U05, PR này chưa merge vào main; hai conflict cần xử lý là
  `backend/package.json` và `docs/decisions.md`. U05 không tự merge nhánh đồng đội.
  Khi ghép cần giữ mọi test script và chạy lại source kết hợp.
- Next proxy `/api/grants/:path*` dùng chung `BACKEND_URL` đã được B04 kiểm tra.
  API đi qua cùng origin HTTPS để Core điện thoại truy cập được; không cần mở
  CORS rộng hoặc đưa địa chỉ backend loopback vào trình duyệt điện thoại.

## Luồng người dùng

1. Mở `/student` trong trình duyệt Core, kết nối ví được B03/B05 cấp và chuyển
   đúng chain `20261`. Bảng hiển thị beneficiary, vault, căn-tin, FOOD và block đọc.
   `balanceWei: null` hoặc lỗi đọc hiện “Chưa xác minh”; chỉ response xác minh
   được số 0 mới hiển thị `0 CAMPUS`.
2. Nhập `1000` để xem số voucher dự kiến trừ. Dùng dấu chấm khi nhập phần lẻ,
   tối đa 18 chữ số thập phân, không nhận ký pháp khoa học. Tiền luôn là bigint
   hoặc chuỗi wei; định dạng phân cách chỉ dùng khi hiển thị.
3. Bấm **Chi FOOD bằng Core**. App đọc lại B05, kiểm tra ví/mạng, đọc số dư,
   allowlist và liên kết issuer/registry trên RPC tại block ghim, mô phỏng
   `spend` ở latest và kiểm tra block vẫn canonical ngay trước bước ký.
   Merchant/category/ABI lấy từ manifest chung, không lấy từ input tùy ý.
4. Core của beneficiary xác nhận giao dịch `value: 0`; gas được hiển thị và
   trả riêng bởi ví. Trước khi gọi ví, app lưu intent công khai để tránh gửi lại
   sau mất mạng/reload. Sau khi có hash, app lưu hash và tra B05 mỗi 2,5 giây.
5. Chỉ B05 receipt đã xác minh, đúng `GrantSpent`, beneficiary/merchant/category,
   số tiền/hash và block sau intent mới làm app xác nhận thành công. Số dư
   hiển thị là snapshot chain mới, không tự trừ bằng JavaScript. Sau `5000 →
   chi 1000 → 4000`, bấm **Xem lại số dư để tạo khoản chi mới** nếu muốn một
   khoản chi khác; không dùng nút này như gửi lại giao dịch cũ.

Quyền merchant hiển thị là quyền hiện tại, còn receipt thành công phản ánh
allowlist tại thời điểm thực thi. Merchant có thể bị gỡ sau lần chi hợp lệ;
việc đó không làm mất hiệu lực receipt cũ. UI không cho chọn ví cá nhân hoặc
PARKING từ ngân sách FOOD. Contract tiếp tục chặn các đường gọi bị sửa.

## Gián đoạn, nhiều tab và lưu trữ

Journal `intracampus.grant.spend.v1:<chain>:<deployment hash>:<beneficiary>`
chỉ chứa địa chỉ/category, số tiền, block bắt đầu và hash công khai, không có khóa.
Journal được chia sẻ giữa các tab cùng origin. Web Locks khóa bước claim/gửi và
cập nhật trạng thái; phản hồi cũ không được ghi đè intent mới. Đổi origin hoặc
xóa storage làm mất cơ chế khôi phục, vì vậy giữ cùng URL HTTPS trong buổi demo.

- Cần HTTPS/loopback, localStorage và **Web Locks** để gửi. Chromium/Edge/Core
  có hỗ trợ API này dùng được; trình duyệt không có hỗ trợ chỉ cho đọc và hiện
  hướng mở trình duyệt tương thích. Cần kiểm tra phiên bản Core thật trước demo.
- Từ chối ký hoặc ví xác nhận chắc chắn chưa gửi: bỏ intent, có thể xem lại và
  thử khoản chi mới. Lỗi truyền sau khi gọi ví hoặc hash không hợp lệ: giữ
  intent **chưa rõ kết quả**, chặn mọi lần chi tiếp theo.
- Mất hash: kiểm tra đúng giao dịch trong lịch sử Core, nhập hash để đối chiếu.
  Receipt cũ trước block intent, sai người/merchant/số tiền không được chấp nhận.
  Hash tự nhập bị revert không chứng minh giao dịch ban đầu chưa gửi, nên vẫn
  chặn chi lại; sửa hash tra cứu đúng từ Core. Không xóa storage để vượt chặn.
- Có hash nhưng RPC mất: giữ hash, không gửi lại; số dư cũ được gắn nhãn “cần
  đọc lại”. Receipt revert của hash do chính ví trả về giữ voucher, nhưng ví
  vẫn có thể mất gas. Không dùng số dư thay đổi như bằng chứng receipt.
- Không lưu được intent thì không mở ví. Lỗi lưu hash sau gửi vẫn hiển thị hash
  trong phiên và giữ intent chưa rõ kết quả trên disk; ghi lại hash, xử lý quyền
  lưu trữ rồi đối chiếu trước khi tiếp tục.

## Kiểm tra và nghiệm thu

Từ gốc repo với Node 24, pnpm 11.25.0:

```sh
node --test frontend/test/grants.test.ts
pnpm typecheck
pnpm test
pnpm build
```

Test tự động có: parser B05, calldata đối chiếu ABI compiler, tiền lẻ wei, sai
chain/merchant/category, vượt số dư, receipt sai/cũ/revert/pending, RPC mất,
storage lỗi, gửi chưa rõ kết quả/reload, account đổi khi Core mở, hai tab cùng
chi và phản hồi xác nhận muộn. Đây là provider/HTTP giả lập; receipt EVM local
và video Core/điện thoại/L1 phải được ghi riêng.

Nghiệm thu hai thiết bị: operator seed B03/B05, sinh viên tự ký chi `1000`
từ `5000`; đối chiếu API, `GrantSpent`, merchant tăng `1000` và voucher còn
`4000`. Thử merchant bị gỡ, ví cá nhân, sai category và vượt số dư; ngân sách
giữ nguyên. Thử từ chối ký, đổi ví/chain, mất RPC trước/sau hash và reload.
Ghi ảnh trước/sau, chain, deployment, hash/block/event và nhãn môi trường;
chỉ bằng chứng thật mới đủ nghiệm thu L1.
