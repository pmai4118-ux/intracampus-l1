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

Chữ ký `signature` dài `65` byte theo thứ tự chuẩn `r (32 byte) || s (32 byte) || v (1 byte, giá trị 27 hoặc 28)`, biểu diễn ở dạng chuỗi hex có tiền tố `0x` (132 ký tự bao gồm `0x`). Hợp đồng chỉ chấp nhận chữ ký có `s` ở nửa dưới đường cong secp256k1 (EIP-2 malleable signature check, có sẵn trong OpenZeppelin `ECDSA.recover`) và địa chỉ khôi phục được phải trùng với `CampusPaymentRegistry.posSigner()`, signer POS chung của hệ thống trong MVP.

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

    function posSigner() external view returns (address);

    function quoteInvoice(Invoice calldata invoice, address payer)
        external
        view
        returns (uint8 tier, uint256 discountAmount, uint256 paidAmount);

    function payInvoice(Invoice calldata invoice, bytes calldata signature) external payable;

    function isInvoicePaid(bytes32 invoiceId) external view returns (bool);
}
```

`posSigner()` trả về địa chỉ khác `address(0)` mà chính `payInvoice` dùng để xác minh chữ ký và làm `expectedSigner` trong lỗi `InvalidSignature`. `L04` phải cung cấp getter này trên `CampusPaymentRegistry`; `L06` ghi địa chỉ verifier và signer công khai tương ứng trong `deployments/intracampus.json`. `B01` đối chiếu địa chỉ suy ra từ khóa ký backend với getter trước khi phát hành hóa đơn; `U03` dùng cùng getter để kiểm tra trước khi mở ví. Getter là hàm đọc, không yêu cầu sinh viên ký giao dịch.

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

1. Parse JSON và kiểm tra kiểu/giới hạn trước khi băm: `schemaVersion === 1`; địa chỉ 20 byte khác zero, ID/category 32 byte; `amount` là chuỗi số nguyên thập phân dương trong miền `uint256`; `expiresAt` và `issuedAt` là Unix giây không âm, `Number.isSafeInteger`, `expiresAt` nằm trong miền `uint64`. Chữ ký phải là hex 65 byte, low-s và v 27/28. Từ chối dữ liệu không hợp lệ bằng `INVALID_QR_PAYLOAD` / `INVALID_SIGNATURE`.
2. Kiểm tra đầy đủ domain: `name === "IntraCampusPayment"`, `version === "1"`, `chainId === 20261` và verifier khớp cấu hình triển khai tin cậy `L06`. Kiểm tra cả chain thực tế của ví/RPC, không chỉ chain tự khai báo trong QR. Địa chỉ được chuẩn hóa trước khi so sánh.
3. Kiểm tra `keccak256(utf8Bytes(meta.invoiceCode)) === invoice.invoiceId` và `keccak256(utf8Bytes(meta.categoryCode)) === invoice.category`. Tra bộ `(invoice.merchant, invoice.category, invoice.amount, meta.merchantId, meta.serviceId)` trong danh mục tin cậy cấu hình sẵn hoặc đối chiếu qua `GET /api/invoices/:invoiceId`; tên merchant/dịch vụ phải khớp nguồn này. Chỉ hiển thị tên và thời điểm tạo từ nguồn tin cậy, không xem metadata trong QR là dữ liệu đã ký. Sai lệch trả `UNKNOWN_SERVICE_OR_MERCHANT` / `INVALID_QR_PAYLOAD`.
4. Tính EIP-712 digest và recover signer. Địa chỉ recover phải khớp cả `envelope.signer` và signer được ủy quyền tin cậy. Nguồn on-chain là `CampusPaymentRegistry.posSigner()` tại verifier đã cấu hình trên RPC `20261`; signer cấu hình sẵn phải gắn với cùng bản triển khai `L06`. Không lấy verifier/signer tin cậy từ QR. Signer zero hoặc không khớp trả `INVALID_SIGNATURE`; lỗi RPC/sai chain trả `RPC_UNAVAILABLE` / `WRONG_CHAIN`, chặn mở ví.
5. **Bắt buộc kiểm tra đã trả trước khi mở yêu cầu thanh toán:** đọc `isInvoicePaid(invoiceId)` từ verifier hoặc GET có biên nhận đã xác minh. Nếu đã trả, hiển thị biên nhận/`INVOICE_ALREADY_PAID` và khóa gửi mới, kể cả QR vẫn còn hạn. Nếu không xác minh được thì chặn gửi mới, thử đọc lại. Khi đã có txHash chưa rõ kết quả, tiếp tục đối chiếu hash cũ theo [quy tắc GET](api-contract.md#33-thứ-tự-xử-lý-get-và-chuyển-trạng-thái), không tự gửi lại.
6. **Xét hạn theo chain, không theo đồng hồ điện thoại:** đọc timestamp block mới nhất từ RPC tin cậy. Nếu `block.timestamp > expiresAt`, trả `INVOICE_EXPIRED`; tại đúng `expiresAt` vẫn còn hiệu lực. `Date.now()` chỉ dùng để hiển thị countdown từ mốc chain đã đọc, không quyết định mở ví. Nếu dữ liệu chain không đọc được thì chặn gửi mới.
7. Ngay trước khi yêu cầu ví gửi, lấy `quoteInvoice(invoice, walletAddress)` và mô phỏng `payInvoice(invoice, signature)` bằng `eth_call` hoặc `eth_estimateGas` trên trạng thái mới nhất, với đúng `from`, verifier, calldata và `value = paidAmount`. Mô phỏng phải thành công; lỗi expired/already-paid/signer/merchant/giá được ánh xạ theo bảng lỗi. Hiển thị số tiền, đích nhận, mạng và phí tách riêng để người dùng xác nhận. Chặn gửi nếu ví đổi tài khoản/chain; làm lại preflight. Mô phỏng không ký, không gửi và không tốn gas on-chain.

Preflight không thay thế kiểm tra trong contract: có thể hết hạn, đổi tier hoặc có người trả trước trong lúc người dùng mở ví. `U04` vẫn xử lý revert và đối chiếu receipt của giao dịch đã gửi; tuyệt đối không tự gửi lại khi chưa xác minh được kết quả. Các bước 5–7 là điểm nối `U03` → `U04`/`B04`; `U03` độc lập vẫn có thể hiển thị bản xem trước nhưng chưa bật gửi khi thiếu dữ liệu tin cậy.

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

## 6. Fixture chạy được và kiểm tra giao kèo

Nguồn máy đọc được: [`fixtures/invoice-v1.json`](fixtures/invoice-v1.json). `pnpm test:p02` kiểm tra JSON/QR, hash/chữ ký, event ABI, giá và bảng tình huống receipt/preflight/lookup. `contracts/test/InvoiceVectors.t.sol` đọc cùng fixture để so digest/recover bằng Solidity 0.8.24 trong `forge test`. Cả hai chạy trong CI qua `pnpm test` và job Foundry.

Đây là kiểm tra giao kèo và vector, chưa phải implementation `L04`/`B01`/`B02`. Các module sau phải dùng lại fixture, chạy lại các tình huống với service/contract thật và bổ sung test quyền, gửi native CAMPUS, replay, merchant tắt, thẻ hết hạn/thu hồi. Không coi CI vector đạt là bằng chứng giao dịch L1.
