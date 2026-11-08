# P02 · Giao kèo hóa đơn EIP-712, payload QR và sự kiện thanh toán

Ngày soạn: 08/11/2026. Trạng thái: bản đề xuất giao kèo kỹ thuật `P02` để nhóm review và làm cơ sở triển khai cho `L04`, `B01`, `B02`, `U03`, `U04`.

Tài liệu đi cùng: [giao kèo HTTP API và mã lỗi](api-contract.md), [phạm vi MVP](scope.md) và [kịch bản demo hai thiết bị](demo-flow.md).

## 1. Mục tiêu và nguyên tắc chung

Tài liệu này khóa định dạng dữ liệu hóa đơn, miền ký EIP-712 (`domain`), cấu trúc `Invoice`, payload mã QR (theo phương án tự chứa đầy đủ dữ liệu đã ký), công thức tính ưu đãi theo thẻ SBT và sự kiện `InvoicePaid` giữa ba lớp:

1. **POS Backend (`B01`, `B02`, `B04`):** tạo hóa đơn từ danh mục dịch vụ demo, ký EIP-712 bằng khóa POS và xác minh biên nhận từ sự kiện on-chain.
2. **Smart Contract (`L04`):** xác minh chữ ký của POS signer, thời hạn `expiresAt`, ràng buộc `merchant`/`category`, chống trả trùng theo `invoiceId`, tính số tiền cuối từ thẻ SBT và phát sự kiện `InvoicePaid`.
3. **Frontend POS & Student (`U03`, `U04`):** hiển thị/quét/dán payload QR, kiểm tra sơ bộ schema/mạng/hạn/chữ ký trước khi mở ví và gửi giao dịch lên chain `20261`.

Quy tắc số học bắt buộc theo [AGENTS.md](../AGENTS.md):

- Mọi giá trị tiền tệ của đồng gốc `CAMPUS` (`18` chữ số thập phân) được tính ở đơn vị nhỏ nhất (`wei`).
- Trong Solidity dùng `uint256`; trong TypeScript dùng `bigint`; khi truyền qua JSON hoặc mã QR dùng **chuỗi số nguyên base-10** (ví dụ `"3000000000000000000000"` cho `3.000 CAMPUS`).
- Tuyệt đối không dùng số thực dấu phẩy động (`number` thập phân) để lưu hoặc tính số tiền ưu đãi.

## 2. Cấu hình EIP-712 Domain và kiểu `Invoice`

### 2.1. EIP-712 Domain

Hợp đồng thanh toán `CampusPaymentRegistry` (`L04`) và POS Backend (`B01`) dùng cùng bộ tham số miền EIP-712:

| Trường | Kiểu EIP-712 | Giá trị chuẩn | Ghi chú |
| --- | --- | --- | --- |
| `name` | `string` | `"IntraCampusPayment"` | Tên miền ký cố định cho luồng thanh toán hóa đơn |
| `version` | `string` | `"1"` | Phiên bản schema EIP-712 |
| `chainId` | `uint256` | `20261` (`0x4f25`) | Chain ID của IntraCampus L1 từ `@intracampus/network` |
| `verifyingContract` | `address` | Địa chỉ `CampusPaymentRegistry` | Chốt từ `deployments/intracampus.json` (`L06`); trong fixture đối chiếu dùng `0x0000000000000000000000000000000000020261` |

Chuỗi định nghĩa kiểu domain chuẩn:

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
```

- `DOMAIN_TYPEHASH` = `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`
  = `0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f`
- `keccak256("IntraCampusPayment")` = `0x2bb3224df35ff0dd8ccfe9f11a658aeec4d53f44e11301205cad29dd0ea9ec13`
- `keccak256("1")` = `0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6`

### 2.2. Cấu trúc `Invoice` (Primary Type)

Chuỗi định nghĩa kiểu `Invoice` chuẩn (không có khoảng trắng sau dấu phẩy):

```text
Invoice(bytes32 invoiceId,address merchant,bytes32 category,uint256 amount,uint64 expiresAt)
```

- `INVOICE_TYPEHASH` = `keccak256("Invoice(bytes32 invoiceId,address merchant,bytes32 category,uint256 amount,uint64 expiresAt)")`
  = `0x61ce85439e4d0fa432fc506d5ef76f9c6c6b1f7c73d05240153e3abb30393691`

| Trường | Kiểu Solidity / EIP-712 | Kiểu JSON | Quy tắc sinh và kiểm tra |
| --- | --- | --- | --- |
| `invoiceId` | `bytes32` | `string` (`0x` + 64 hex) | Mã định danh hóa đơn duy nhất, tính bằng `keccak256(utf8Bytes(invoiceCode))` (ví dụ `invoiceCode = "INV-20261108-PARKING-0001"`). Mỗi lần tạo QR sinh mã mới; hợp đồng đánh dấu đã dùng để chống trả trùng (replay) |
| `merchant` | `address` | `string` (`0x` + 40 hex) | Địa chỉ ví nhận thanh toán của điểm thu; phải đang hoạt động trong registry |
| `category` | `bytes32` | `string` (`0x` + 64 hex) | Mã nhóm dịch vụ tính bằng `keccak256(utf8Bytes(categoryCode))`. Với bãi xe demo: `categoryCode = "PARKING"` $\rightarrow$ `0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb` |
| `amount` | `uint256` | `string` (số nguyên wei) | Giá gốc trước ưu đãi do backend ấn định từ menu dịch vụ (`> 0`). Với gửi xe demo: `"3000000000000000000000"` (`3.000 CAMPUS`) |
| `expiresAt` | `uint64` | `number` (Unix giây) | Thời điểm hết hạn hóa đơn tính bằng giây Unix (`issuedAt + 300`). Hợp đồng yêu cầu `block.timestamp <= expiresAt` |

### 2.3. Công thức băm EIP-712 trên Solidity và TypeScript

```solidity
bytes32 structHash = keccak256(
    abi.encode(
        INVOICE_TYPEHASH,
        invoice.invoiceId,
        invoice.merchant,
        invoice.category,
        invoice.amount,
        invoice.expiresAt
    )
);

bytes32 digest = keccak256(
    abi.encodePacked("\x19\x01", domainSeparator, structHash)
);
```

Chữ ký `signature` dài `65` byte theo thứ tự chuẩn `r (32 byte) || s (32 byte) || v (1 byte, giá trị 27 hoặc 28)`, biểu diễn ở dạng chuỗi hex có tiền tố `0x` (132 ký tự bao gồm `0x`). Hợp đồng chỉ chấp nhận chữ ký có `s` ở nửa dưới đường cong secp256k1 (EIP-2 malleable signature check, có sẵn trong OpenZeppelin `ECDSA.recover`) và địa chỉ khôi phục được phải trùng với `authorizedSigner` của merchant/hệ thống.

## 3. Quy tắc tính giá cuối theo thẻ SBT và ABI hợp đồng (`L04`)

### 3.1. Công thức tính ưu đãi và làm tròn

Hợp đồng `CampusPaymentRegistry` đọc trạng thái thẻ của `msg.sender` (hoặc `payer`) từ hợp đồng `StudentSBTIdentity` (`L03`):

| Điều kiện thẻ SBT của người trả (`payer`) | Giá trị `tier` | Mức giảm (`discountBps`) | Công thức `discountAmount` (wei) | Số phải trả `paidAmount` (wei) với giá gốc `3.000 CAMPUS` |
| --- | --- | --- | --- | --- |
| Không có thẻ, thẻ bị thu hồi (`revoked`) hoặc đã quá hạn (`block.timestamp > sbtExpiresAt`) | `0` | `0` (`0%`) | `0` | `"3000000000000000000000"` (`3.000 CAMPUS`) |
| Có thẻ sinh viên hợp lệ và còn hạn (`block.timestamp <= sbtExpiresAt`) | `1` | `1000` (`10%`) | `(amount * 1000) / 10000` | `"2700000000000000000000"` (`2.700 CAMPUS`) |

Quy tắc làm tròn bắt buộc:

- Dùng phép chia nguyên làm tròn xuống (`floor division`) theo đơn vị `wei`:
  $$\text{discountAmount} = \left\lfloor \frac{\text{amount} \times \text{discountBps}}{10000} \right\rfloor$$
  $$\text{paidAmount} = \text{amount} - \text{discountAmount}$$
- Hợp đồng chỉ chấp nhận giao dịch khi `msg.value == paidAmount` (không nhận thừa để tránh phát sinh luồng hoàn tiền phức tạp và nguy cơ reentrancy).
- Trước khi chuyển `paidAmount` sang địa chỉ `merchant`, hợp đồng phải đánh dấu `paidInvoices[invoice.invoiceId] = true` (theo mẫu Checks-Effects-Interactions).

### 3.2. Giao kèo ABI của `CampusPaymentRegistry` (`L04`)

```solidity
// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.24;

interface ICampusPaymentRegistry {
    struct Invoice {
        bytes32 invoiceId;
        address merchant;
        bytes32 category;
        uint256 amount;
        uint64 expiresAt;
    }

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

    error InvoiceExpired(bytes32 invoiceId, uint64 expiresAt, uint256 currentTimestamp);
    error InvoiceAlreadyPaid(bytes32 invoiceId);
    error InvalidSignature(address recoveredSigner, address expectedSigner);
    error InvalidMerchantOrCategory(address merchant, bytes32 category);
    error IncorrectPaymentAmount(uint256 sentValue, uint256 requiredAmount);
    error MerchantTransferFailed(address merchant, uint256 amount);

    function quoteInvoice(Invoice calldata invoice, address payer)
        external
        view
        returns (uint8 tier, uint256 discountAmount, uint256 paidAmount);

    function payInvoice(Invoice calldata invoice, bytes calldata signature) external payable;

    function isInvoicePaid(bytes32 invoiceId) external view returns (bool);
}
```

## 4. Định dạng Payload QR tự chứa (Phương án A)

Để thiết bị B (`/student` trên điện thoại) có thể giải mã, kiểm tra hạn, đối chiếu chữ ký và hiển thị bản xem trước ngay lập tức sau khi quét camera hoặc dán chuỗi văn bản mà không phụ thuộc thêm một vòng gọi mạng về POS API, nội dung mã QR (`qrPayload`) là chuỗi JSON thu gọn (minified UTF-8 JSON) theo cấu trúc `SignedInvoiceEnvelope`:

```json
{
  "schemaVersion": 1,
  "domain": {
    "name": "IntraCampusPayment",
    "version": "1",
    "chainId": 20261,
    "verifyingContract": "0x0000000000000000000000000000000000020261"
  },
  "invoice": {
    "invoiceId": "0x7dec24e2691f51c0bc1822acf25d4b07c5bd73ed5d641cc604f22eead02e69b1",
    "merchant": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "category": "0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb",
    "amount": "3000000000000000000000",
    "expiresAt": 1794142800
  },
  "meta": {
    "invoiceCode": "INV-20261108-PARKING-0001",
    "merchantId": "parking-demo",
    "merchantName": "Bãi xe demo",
    "serviceId": "parking-single",
    "serviceName": "Một lượt gửi xe demo",
    "categoryCode": "PARKING",
    "issuedAt": 1794142500
  },
  "signer": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "signature": "0x8a46fc98a37a6f12390c3bb91a6a02788e4e95542f99c1b3173de7070dbb222b5411461dc14d0f36c035742f31d6adb883efad686d9c85bd7c6a5a591b5b18581b"
}
```

Quy tắc kiểm tra phía `/student` (`U03`) khi quét hoặc dán `qrPayload`:

1. Parse JSON, kiểm tra `schemaVersion === 1`, các trường bắt buộc trong `domain`, `invoice`, `meta`, `signer`, `signature`.
2. Kiểm tra `domain.chainId === 20261` và `domain.verifyingContract` khớp địa chỉ hợp đồng đang cấu hình trên app.
3. Kiểm tra `keccak256(utf8Bytes(meta.invoiceCode)) === invoice.invoiceId` và `keccak256(utf8Bytes(meta.categoryCode)) === invoice.category`.
4. Kiểm tra thời hạn: `Math.floor(Date.now() / 1000) <= invoice.expiresAt`.
5. Tính lại EIP-712 `digest` từ `domain` + `invoice`, khôi phục địa chỉ từ `signature` và kiểm tra trùng với `signer`. Nếu bất kỳ bước nào sai, chặn nút mở ví ký và hiển thị lỗi theo bảng mã lỗi tại [api-contract.md](api-contract.md).

## 5. Bộ Fixture đối chiếu Digest và Chữ ký (TypeScript ↔ Solidity)

> **Lưu ý bảo mật:** Khóa dưới đây là tài khoản thử nghiệm công khai `#0` của Foundry Anvil, **chỉ dùng để kiểm thử tự động các vector EIP-712**, tuyệt đối không dùng để giữ tài sản thật.

- **Test Signer Private Key (Anvil #0):** `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
- **Test Signer Address (`expectedSigner`):** `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
- **Test Merchant Address (Anvil #1):** `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`

### 5.1. Fixture 1 — Payload chuẩn hợp lệ (`3.000 CAMPUS`, `chainId = 20261`)

- **Đầu vào `domain`:**
  - `name`: `"IntraCampusPayment"`
  - `version`: `"1"`
  - `chainId`: `20261`
  - `verifyingContract`: `"0x0000000000000000000000000000000000020261"`
- **Đầu vào `invoice`:**
  - `invoiceId`: `0x7dec24e2691f51c0bc1822acf25d4b07c5bd73ed5d641cc604f22eead02e69b1` (`keccak256("INV-20261108-PARKING-0001")`)
  - `merchant`: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`
  - `category`: `0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb` (`keccak256("PARKING")`)
  - `amount`: `"3000000000000000000000"` (`3.000 CAMPUS`)
  - `expiresAt`: `1794142800`
- **Kết quả băm và chữ ký (phải khớp ở cả Backend và Solidity):**
  - `domainSeparator`: `0xd5847794aab6c04d4c28223f4b441499b286ad162e4bea62daff93d2b50b5ef0`
  - `structHash`: `0xcb2e4e84302b0edf3e9351b1751c9c95468e6c2b988a60cc090f11c71c3c6940`
  - `digest`: `0x277c37ec95f4baa53fabeff6de7933b8a24197a3d9a8abb69667d18a30f965c7`
  - `r`: `0x8a46fc98a37a6f12390c3bb91a6a02788e4e95542f99c1b3173de7070dbb222b`
  - `s`: `0x5411461dc14d0f36c035742f31d6adb883efad686d9c85bd7c6a5a591b5b1858`
  - `v`: `27` (`0x1b`)
  - `signature`: `0x8a46fc98a37a6f12390c3bb91a6a02788e4e95542f99c1b3173de7070dbb222b5411461dc14d0f36c035742f31d6adb883efad686d9c85bd7c6a5a591b5b18581b`
  - `ecrecover(digest, v, r, s)`: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (**Khớp `expectedSigner`**)

### 5.2. Bảng đối chiếu các Fixture bị sửa dữ liệu (Negative Fixtures)

Giữ nguyên `signature` của Fixture 1 nhưng thay đổi một tham số trong payload hoặc domain:

| Tình huống kiểm thử | Trường bị thay đổi | `domainSeparator` mới | `structHash` mới | `digest` mới | Địa chỉ `ecrecover` trả về | Kết quả kiểm tra với `expectedSigner` |
| --- | --- | --- | --- | --- | --- | --- |
| **Fixture 2: Sửa `amount`** (cố tình hạ giá gốc xuống `2.700 CAMPUS`) | `amount = "2700000000000000000000"` | `0xd5847794aab6c04d4c28223f4b441499b286ad162e4bea62daff93d2b50b5ef0` (giữ nguyên) | `0xb97c43bd3d59ddeb7781375eb2888d398a7d0d5b10d2da3ec0f8cb0aff5c6288` | `0x48573cceaba8f0f9e86e3f07c746e2d03205f2ee1fcf59f873785a81315fff18` | `0xbfd8819F1505CBa1e81e587a1f91CC32bd932A65` | **Thất bại** (`!= expectedSigner` $\rightarrow$ `INVALID_SIGNATURE`) |
| **Fixture 3: Sai `chainId`** (gửi chữ ký sang mạng Fuji `43113`) | `domain.chainId = 43113` | `0x308d0ca075d19e274a1944c6894acf512a360649f15934e01eb30eef37d83128` | `0xcb2e4e84302b0edf3e9351b1751c9c95468e6c2b988a60cc090f11c71c3c6940` (giữ nguyên) | `0x2b057b027c69202375c6524db2bf65c560a770853ef419c52c2926f4b9ffbe5c` | `0x8978c114a8EaF7DDe799831529B3D896E7e31a5F` | **Thất bại** (`!= expectedSigner` $\rightarrow$ `WRONG_CHAIN` / `INVALID_SIGNATURE`) |
| **Fixture 4: Sai `verifyingContract`** (replay chữ ký sang contract khác) | `domain.verifyingContract = "0x0000000000000000000000000000000000099999"` | `0x443a8281846af8d0e3f08621d82b197525f4fcafa316199fcb6e7624c7758bb9` | `0xcb2e4e84302b0edf3e9351b1751c9c95468e6c2b988a60cc090f11c71c3c6940` (giữ nguyên) | `0x6857a10a1bdb1fdb9748cc59469ef7b8561364a23b9b13a506f50e6526bf60f2` | `0x7840b8A44889CB8D866e4058eb07c44AB4f1851c` | **Thất bại** (`!= expectedSigner` $\rightarrow$ `INVALID_SIGNATURE`) |
