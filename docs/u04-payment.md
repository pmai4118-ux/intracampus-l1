# U04 · QR → ví sinh viên → biên nhận POS

U04 nối bản xem trước U03 với giao dịch do chính ví Core của sinh viên ký.
Backend B01 chỉ ký hóa đơn EIP-712; CAMPUS thanh toán và gas đến từ ví sinh
viên. Biên nhận dùng GET B02/B04, không suy ra thành công chỉ từ tx hash.

## Chuẩn bị và chạy

1. Dùng Node 24, pnpm 11.25.0 và source có B01/B02/B04, U02/U03, L04/L06.
   Từ gốc chạy `pnpm install --frozen-lockfile`.
2. Operator bàn giao RPC HTTPS chain `20261` cùng manifest L06 đã kiểm chứng,
   `status: deployed`, `environment: avalanche-l1`. File canonical còn
   `unconfigured` thì chưa bật thanh toán. Không thay bằng địa chỉ Anvil để
   nghiệm thu L1. Xem [L06](deployment.md) và [B04](b04-integration.md).
   Trình duyệt phải có Web Locks và lưu trữ local hoạt động; mở trang HTTPS
   trong Core/Chromium để khóa yêu cầu giữa các tab.
3. Đặt RPC công khai ở `frontend/.env.local`, RPC và POS signer riêng ở backend
   theo [hướng dẫn chạy](run-local.md). Địa chỉ/ABI/role dùng cùng deployment;
   env tương thích phải khớp. Giữ SQLite trên volume bền vững.
4. B03 chuẩn bị hai ví sinh viên có CAMPUS trả tiền/gas: ví thường và ví có SBT
   tier 1 còn hạn. Ví operator không thay ví sinh viên để trả invoice.
5. Chạy `pnpm rpc:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`; sau đó
   khởi động web/backend từ cùng source và manifest. Đổi deployment hoặc public
   env thì rebuild frontend và restart backend.

## Thao tác hai thiết bị

Trên laptop mở `/pos`, tạo một invoice bãi xe mới. Trên điện thoại mở
`/student` trong phiên Core đã kết nối, kiểm tra chain 20261 rồi quét hoặc
dán nguyên payload từ POS. Camera bị từ chối vẫn có đường dán payload.

Đọc merchant, mạng, giá gốc, ưu đãi và số phải trả. Khi bấm thanh toán, U04
đọc lại account/chain, hóa đơn backend, signer, thời gian chain và paid flag;
quote và simulate `payInvoice` lại với đúng payer/value. Giá thay đổi yêu cầu
xem và xác nhận lại. Số dư hiển thị trong U02 không thay preflight này.

Core nhận `payInvoice(invoice, signature)` từ chính ví sinh viên, tới registry
trong manifest, với `msg.value = paidAmount` nguyên wei. Gas được ví tính và
hiển thị riêng. Contract vẫn có thể revert nếu trạng thái thay đổi trong lúc
cửa sổ ví đang mở.

Sau khi gửi, giữ invoiceId và hash. Student và POS tra cùng endpoint
`GET /api/invoices/:invoiceId?txHash=...`; POS cũng tự tìm event theo invoiceId,
không cần chia sẻ localStorage giữa hai thiết bị. Chỉ receipt thành công và
`InvoicePaid` đã xác minh mới bật biên nhận. Student đối chiếu thêm payer của
lần ký, verifier và hash; POS hiển thị biên nhận hóa đơn đã được backend xác minh.

## Gián đoạn và chạy lại

- Từ chối ký trong Core: chưa có thanh toán; có thể kiểm tra lại rồi chủ động
  thử lại. Không tự mở lại popup.
- Đang chờ Core, đã có hash, receipt chưa có hoặc RPC lỗi: khóa gửi tiếp và
  giữ trạng thái chưa rõ. Reload chỉ tra cứu lại giao dịch cũ.
- Mất phản hồi khi gửi: có thể giao dịch đã được phát đi. Giữ dấu lần gửi,
  đối chiếu trong Core và nhập hash công khai để khôi phục; không xóa dữ liệu
  trình duyệt để thử gửi lại.
- Đổi tài khoản/chain: dữ liệu preflight cũ không dùng được; giao dịch đã gửi
  vẫn thuộc tài khoản và deployment lúc gửi. Quay lại tài khoản cũ để đối chiếu.
- Receipt revert: hóa đơn chưa được trả bởi lần đó. Giao diện giữ hash để đối
  chiếu và yêu cầu POS tạo invoice mới; không tự thử lại giao dịch cũ.
- Event/hash/payer không khớp: không báo Student thanh toán thành công. Giữ
  hash và nhờ operator đối chiếu receipt.
- Storage không ghi được: chặn gửi mới để tránh mất dấu lúc reload. Dữ liệu
  đã lưu trên trình duyệt chỉ phục vụ khôi phục, không chứng minh đã trả tiền.

## Kiểm tra nghiệm thu

| Tình huống | Kết quả cần quan sát |
| --- | --- |
| Hai invoice mới cùng mặt hàng | Ví thường trả 3.000; ví tier 1 trả 2.700 CAMPUS; event payer đúng ví ký |
| QR bị sửa, sai signer/verifier, hết hạn hoặc đã trả | Không mở yêu cầu ký mới |
| Quote thay đổi sau màn hình xem trước | Hiển thị giá mới và yêu cầu người dùng xác nhận lại |
| Từ chối ký, đổi ví hoặc mạng giữa preflight | Không gửi với thông tin cũ, không báo thành công |
| Receipt null, mất RPC hoặc reload khi pending | Giữ hash và tra tiếp; không gửi lại |
| Receipt revert hoặc event/payer sai | Không báo thành công |
| POS reload, API restart rồi đọc lại | Khôi phục cùng invoice/receipt; không tạo thanh toán mới |

Test provider/RPC tổng hợp và Anvil chỉ xác nhận implementation local. Nghiệm
thu L1 cần clip không cắt từ QR → Core → biên nhận trên hai thiết bị HTTPS,
hai invoiceId/hash thật, cùng deployment và số tiền/event đối chiếu được.
Chỉ reviewer nghiệm thu mới đánh dấu task Xong trên bảng.
