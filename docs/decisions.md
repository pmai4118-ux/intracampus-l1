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

- Sau review toàn bộ P02, preflight bắt buộc kiểm tra invoice đã trả, thời gian chain và mô phỏng giao dịch trước yêu cầu ví; đồng hồ điện thoại chỉ phục vụ countdown. Backend chuẩn hóa tier và từ chối mọi tier ngoài 0/1.
- GET dùng thêm `transaction` để phân biệt vòng đời invoice với hash chưa xác minh. Chốt response union 200/503/422, `lastKnownStatus`, receipt-null, ưu tiên receipt đúng và cập nhật expired → paid khi đối chiếu muộn. Lookup hết hạn trả 200, không dùng 410.
- Thêm `docs/fixtures/invoice-v1.json`, kiểm tra Node trong `pnpm test:p02` (được gọi từ `pnpm test`) và Foundry đọc cùng fixture. `ethers@6.15.0` chỉ là dev dependency gốc cho vector/ABI, không thêm dependency runtime frontend/backend. Đây là fixture tham chiếu cho các task tích hợp, không thay thế test implementation L04/B01/B02/U03/U04 hoặc bằng chứng L1.

## D008 · L03: thẻ sinh viên và tier hiệu lực · 2026-11-09

[`StudentSBTIdentity`](../contracts/src/StudentSBTIdentity.sol) dùng một issuer cố định, truyền vào constructor khi L06 triển khai. Chỉ issuer gọi `mint(address wallet, uint64 expiresAt)` và `revoke(uint256 tokenId)`. Mỗi ví giữ tối đa một thẻ. Hạn cấp mới phải ở tương lai. Muốn cấp lại, issuer thu hồi thẻ cũ trước, kể cả thẻ đã hết hạn. Thu hồi đốt token và xóa bản ghi hiện tại. Lần cấp sau dùng token ID mới, nên gọi lại `revoke` với ID cũ sẽ revert.

Thẻ khóa ngay khi cấp theo ERC-5192, phát `Transfer` và `Locked`. Mọi hàm chuyển nhượng và cấp quyền đều revert. Thẻ hết hạn vẫn thuộc ví và vẫn khóa cho tới khi issuer thu hồi. Hợp đồng chỉ lưu địa chỉ ví, token ID và hạn Unix tính bằng giây. B03 dùng địa chỉ demo khi cấp thẻ.

L04 dùng `tierOf(address payer) → uint8` để tính giá theo P02. Hàm trả `1` tới hết giây `expiresAt`, và trả `0` cho ví chưa có thẻ, đã quá hạn hoặc đã bị thu hồi. U02 dùng cùng hàm để hiển thị tier. `credentials(address)` trả `(uint256 tokenId, uint64 expiresAt)` để đọc thẻ hiện tại. `balanceOf` biểu thị quyền sở hữu thẻ, còn `tierOf` biểu thị quyền ưu đãi.

L04 có thể dùng lại [`StudentSBTFixture`](../contracts/test/fixtures/StudentSBTFixture.sol) trên Foundry để tạo ba ví đối chứng thường, ưu đãi và quá hạn. Việc cấp thẻ demo trên Avalanche L1 và bàn giao địa chỉ/ABI thuộc B03 và L06.

## D009 · B02: lookup receipt bền vững và giao kèo tích hợp · 2026-11-11

Module invoices dùng SQLite qua `node:sqlite` trên Node 24 để giữ envelope, snapshot, hash đang theo dõi, cursor quét và receipt qua restart. B01 gọi `InvoiceRepository.create(envelope)` trước khi trả 201; B02 cung cấp GET và commit receipt trước khi báo paid. L06 bàn giao verifier/block qua `CAMPUS_PAYMENT_REGISTRY_ADDRESS` và `CAMPUS_PAYMENT_DEPLOYMENT_BLOCK`. Cấu hình được kiểm tra riêng với verifier trong envelope; không tin địa chỉ fixture/QR như cấu hình triển khai.

`ethers@6.15.0` được thêm vào dependency runtime backend để decode ABI; mở rộng quyết định D007 vốn chỉ dùng ethers cho vector dev. `@intracampus/network` export type envelope, receipt và lookup union dùng chung. API bổ sung `Retry-After` trên 503 và `INTERNAL_ERROR` 500 khi kho dữ liệu lỗi; không thay ABI, EIP-712 hoặc các response vòng đời P02. B04/U04 dùng type mới, giữ hash cũ và khử thông báo theo event key.

Backend thực hiện một lookup mỗi GET với backoff khi RPC lỗi, không tạo background indexer/WebSocket. POS/B04/U04 sở hữu lịch poll. [Tài liệu B02](b02-receipts.md) ghi giới hạn một host/volume bền vững và bằng chứng fixture; chưa tuyên bố kiểm tra L1 thật.
