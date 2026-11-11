# L04 · Thanh toán native CAMPUS

`contracts/src/CampusPaymentRegistry.sol` thực thi ABI, kiểu Invoice và sự kiện
[P02](invoice-contract.md) với Solidity 0.8.24 / EVM Paris. Contract dùng
`StudentSBTIdentity.tierOf(payer)` từ L03. Đây là bàn giao contract và bằng chứng
EVM local; địa chỉ dùng chung trên Avalanche L1 thuộc L06.

## Cấu hình cho L06

Constructor: `CampusPaymentRegistry(address admin, address posSigner, address studentSbt)`.
Ba địa chỉ phải hợp lệ; `studentSbt` phải có code đã triển khai. Admin, signer
và địa chỉ SBT cố định suốt đời contract. MVP dùng signer EOA EIP-712; thay các
địa chỉ này cần deploy bản mới và cập nhật cả backend/frontend theo L06.

Registry ban đầu không cho phép merchant nào. Admin gọi
`setMerchantCategory(address merchant, bytes32 category, bool allowed)` để
bật/tắt **từng cặp chính xác**; getter public là
`allowedMerchantCategories(merchant, category)`. Cùng một merchant có thể được
phép nhiều category. Muốn tắt mọi dịch vụ của merchant, admin tắt mọi cặp đã
đăng ký. Mỗi lần cập nhật phát `MerchantCategoryUpdated(merchant, category, allowed)`.
Không đăng ký địa chỉ zero, địa chỉ chính registry hoặc category zero.

Một invoice đã ký vẫn bị chặn nếu cặp merchant/category bị tắt trước lúc giao
dịch được thực thi. Chỉ admin được thay allowlist; POS signer chỉ ký invoice.
B01 không tự gọi hàm quản trị khi tạo hóa đơn.

## Hành vi thanh toán và điểm nối

- Giữ nguyên Invoice, domain `IntraCampusPayment` / `1`, getter `posSigner()` và
  sáu lỗi thanh toán P02. Domain luôn dùng `block.chainid` và `address(this)`;
  cấu hình đích của nhóm là chain 20261. Không hardcode địa chỉ verifier fixture.
- Chữ ký đúng 65 byte, low-s, v 27/28. Thư viện OpenZeppelin ECDSA v5.0.2 được
  ghim nguyên bản trong `contracts/lib/openzeppelin-contracts/`, kèm MIT license
  và SHA-256. Mọi lỗi recover trả lỗi P02 `InvalidSignature`; trường recovered
  bằng zero khi chữ ký không có định dạng hợp lệ.
- `quoteInvoice(invoice, payer)` kiểm tra invoice chưa trả, chưa hết hạn,
  amount dương, invoiceId khác zero và cặp merchant/category đang được phép.
  Hàm không nhận chữ ký. U03/U04 vẫn phải xác minh signer và simulate
  `payInvoice` với đúng `from`, calldata và `value` ngay trước khi mở ví.
- Tier 0 trả giá gốc; tier 1 giảm `floor(amount / 10)` wei. Công thức tương
  đương mức 1000 bps P02 và không nhân tràn uint256. Tier ngoài 0/1 hoặc lỗi
  đọc SBT làm giao dịch revert; không âm thầm bỏ qua lỗi để thu giá khác.
- Tại đúng giây hết hạn invoice vẫn có hiệu lực. Tier lấy ở thời điểm thực thi,
  nên SBT hết hạn/thu hồi sau quote có thể làm giao dịch revert vì sai value.
- Chỉ nhận đúng `msg.value`; đánh dấu invoiceId đã trả trước khi chuyển native
  CAMPUS bằng call, có guard chặn reentrancy. Transfer thất bại revert toàn bộ,
  hoàn tác paid flag và value. Registry không giữ tiền thanh toán thành công.
- Paid flag dùng chung theo invoiceId cho mọi payer và payload. Một invoiceId
  đã trả không được dùng lại dù có chữ ký mới hoặc đã qua hạn.

ABI `InvoicePaid` giữ nguyên cho B02/B04 và U04:

```solidity
event InvoicePaid(
    bytes32 indexed invoiceId,
    address indexed payer,
    address indexed merchant,
    bytes32 category,
    uint256 originalAmount,
    uint256 discountAmount,
    uint256 paidAmount,
    uint8 tier
);
```

Các lỗi bổ sung cho quản trị/cấu hình: `UnauthorizedAdmin()`,
`InvalidConfiguration()`, `InvalidInvoice()`, `UnsupportedTier(uint8)`,
`ReentrantPayment()`. B01/U03 giữ kiểm tra đầu vào P02; backend chỉ công nhận
thanh toán từ receipt thành công và event khớp chain/verifier/invoice, không
dựa riêng vào quote hay tx hash. L05 có thể đọc allowlist theo cặp trên registry;
chưa có logic grant/vault trong L04.

## Kiểm tra và bằng chứng

Chạy trong `contracts/` với Foundry v1.7.1:

```sh
forge fmt --check
forge build
forge test -vv
```

`CampusPaymentRegistry.t.sol` kiểm tra giá thường/ưu đãi, thẻ hết hạn/thu hồi,
ranh giới thời gian, sai value, replay qua payer/payload, quyền admin, cặp
merchant/category, chữ ký sai/malformed/high-s, domain chain/verifier, transfer
thất bại và retry, reentrancy, SBT lỗi/tier lạ. Hai fuzz test kiểm tra số học
uint256 và bảo toàn tiền. Test implementation đọc chữ ký và các mức làm tròn
từ `docs/fixtures/invoice-v1.json`; fixture vector P02 và SBT L03 chạy cùng suite.

Từ gốc repo, sau `pnpm install --frozen-lockfile` và `forge build`:

```sh
pnpm test:p02
pnpm test:l04
node contracts/script/smoke-payment.mjs
```

Smoke script tự mở Anvil trên loopback với cổng trống, chain 20261; dùng tài
khoản test unlocked, deploy SBT/registry, đăng ký merchant, cấp thẻ và ký typed
data bằng signer demo. Có thể đặt `ANVIL_BIN` tới binary v1.7.1 nếu chưa có
trong PATH. Trước khi mở Anvil, script đối chiếu keccak256 của từng source
(kể cả dependency) với metadata compiler trong artifact; nếu source đã đổi,
phải chạy lại `forge build`. Script so ABI artifact với P02, kiểm tra hai receipt/event, số dư
merchant, paid flag và replay, rồi dừng tiến trình Anvil do nó tạo.

Mặc định evidence ghi vào thư mục temp. Truyền đường dẫn output để lưu bản mới:

```sh
node contracts/script/smoke-payment.mjs docs/fixtures/l04-local-receipts.json
```

Bằng chứng của bản bàn giao:

- [Log Foundry](evidence/l04-foundry.txt): 45 test qua, gồm 34 test L04;
  mỗi fuzz test chạy 256 trường hợp.
- [Hai receipt local EVM](fixtures/l04-local-receipts.json): giá thường
  3.000 CAMPUS, tier 1 trả 2.700 CAMPUS, ABI/event đã đối chiếu.
- `pnpm test:p02`: 35 test qua.
- `pnpm test:l04`: 5 regression test của kiểm tra artifact; đã nằm trong
  `pnpm test` nên chạy trong CI.

Các ca bổ sung sau review bao gồm chữ ký high-s vẫn recover đúng signer,
chữ ký compact/overlong, thu hồi SBT sau quote, thanh toán liên tiếp, tắt
category độc lập, reentrancy sang invoice khác, giá uint256 tối đa và giải mã
raw log theo ABI P02. [Báo cáo review](evidence/l04-review.md) ghi lỗi và phạm vi.

Evidence lưu hash source theo UTF-8/LF để đối chiếu giữa Windows và Linux.
Các BigInt của event decoder được ghi thành chuỗi trong JSON evidence; file
này chứa receipt/log EVM, không phải DTO biên nhận HTTP của P02.

Các receipt trên là giao dịch Anvil thật trong EVM local, không phải giao dịch
Avalanche L1. L06 còn cần deploy/configure bộ contract sau L05; B03 cấp ví/thẻ
demo; B01/B02/B04/U03/U04 hoàn tất tích hợp. Nghiệm thu cuối cần CI và review
của thành viên khác theo AGENTS.md.
