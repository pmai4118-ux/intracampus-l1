# P02 · Giao kèo HTTP API cho POS, biên nhận và bảng mã lỗi

Ngày soạn: 08/11/2026. Trạng thái: bản đề xuất giao kèo kỹ thuật `P02` để nhóm review và làm cơ sở triển khai cho `B01`, `B02`, `B04`, `U01`, `U03`, `U04`.

Tài liệu đi cùng: [giao kèo hóa đơn EIP-712 và QR](invoice-contract.md), [phạm vi MVP](scope.md) và [kịch bản demo hai thiết bị](demo-flow.md).

## 1. Phạm vi và nguyên tắc thiết kế API

Module `invoices` trong `backend/src/modules/invoices/` chịu trách nhiệm cho cả vòng đời hóa đơn tại điểm thu (`/pos`):

1. Tạo hóa đơn động từ danh mục dịch vụ demo, ấn định giá gốc phía server và ký EIP-712 (`B01`).
2. Tra cứu trạng thái hóa đơn, đọc transaction receipt từ RPC `20261`, giải mã sự kiện `InvoicePaid` và trả biên nhận đã xác minh cho POS (`B02`, `B04`).

Nguyên tắc bắt buộc:

- **Client không được quyết định giá:** Request tạo hóa đơn chỉ truyền mã merchant và mã dịch vụ (`merchantId`, `serviceId`). Nếu client gửi kèm `amount`, backend bỏ qua hoặc từ chối request.
- **Khóa ký chỉ nằm ở backend:** Private key của POS signer đọc từ biến môi trường (`POS_SIGNER_PRIVATE_KEY` trong `backend/.env`), tuyệt đối không xuất hiện trong phản hồi API, mã QR hay log.
- **Chuỗi số nguyên cho tiền tệ:** Mọi trường số tiền (`amount`, `originalAmount`, `discountAmount`, `paidAmount`) trong JSON đều là chuỗi số nguyên ở đơn vị `wei`.
- **Chỉ báo đã thanh toán khi có receipt và event hợp lệ:** Một `txHash` đang chờ hoặc giao dịch bị revert không bao giờ được trả trạng thái `"paid"`.

## 2. Danh mục dịch vụ và Merchant demo chuẩn (`B01`)

Bảng cấu hình gốc trong `backend/src/modules/invoices/invoice.config.ts` cho luồng chính:

| Trường cấu hình | Giá trị chuẩn | Ghi chú |
| --- | --- | --- |
| `merchantId` | `"parking-demo"` | Mã định danh điểm thu ở tầng HTTP |
| `merchantName` | `"Bãi xe demo"` | Tên hiển thị trên POS và Student |
| `merchant` (địa chỉ ví) | Cấu hình từ env/deploy (fixture: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`) | Địa chỉ nhận `CAMPUS` trên chain `20261` |
| `serviceId` | `"parking-single"` | Mã dịch vụ gửi xe một lượt |
| `serviceName` | `"Một lượt gửi xe demo"` | Tên dịch vụ hiển thị trên giao diện |
| `categoryCode` | `"PARKING"` | Nhãn danh mục dễ đọc |
| `category` (`bytes32`) | `0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb` | `keccak256("PARKING")` |
| `amount` (giá gốc wei) | `"3000000000000000000000"` | `3.000 CAMPUS` |
| `ttlSeconds` | `300` | Thời hạn hóa đơn tính bằng giây (`5` phút) |

## 3. Các Endpoint HTTP

### 3.1. `POST /api/invoices` — Tạo hóa đơn mới và ký payload QR (`B01`)

POS gọi endpoint này khi nhân viên chọn dịch vụ và bấm **Tạo hóa đơn**. Mỗi lần gọi phải sinh một `invoiceCode` và `invoiceId` mới, không tái sử dụng hóa đơn cũ.

#### Request

- **Headers:** `Content-Type: application/json`
- **Body:**

```json
{
  "merchantId": "parking-demo",
  "serviceId": "parking-single"
}
```

#### Response thành công (`201 Created`)

```json
{
  "invoiceId": "0x7dec24e2691f51c0bc1822acf25d4b07c5bd73ed5d641cc604f22eead02e69b1",
  "status": "pending",
  "envelope": {
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
  },
  "qrPayload": "{\"schemaVersion\":1,\"domain\":{\"name\":\"IntraCampusPayment\",\"version\":\"1\",\"chainId\":20261,\"verifyingContract\":\"0x0000000000000000000000000000000000020261\"},\"invoice\":{\"invoiceId\":\"0x7dec24e2691f51c0bc1822acf25d4b07c5bd73ed5d641cc604f22eead02e69b1\",\"merchant\":\"0x70997970C51812dc3A010C7d01b50e0d17dc79C8\",\"category\":\"0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb\",\"amount\":\"3000000000000000000000\",\"expiresAt\":1794142800},\"meta\":{\"invoiceCode\":\"INV-20261108-PARKING-0001\",\"merchantId\":\"parking-demo\",\"merchantName\":\"Bãi xe demo\",\"serviceId\":\"parking-single\",\"serviceName\":\"Một lượt gửi xe demo\",\"categoryCode\":\"PARKING\",\"issuedAt\":1794142500},\"signer\":\"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\",\"signature\":\"0x8a46fc98a37a6f12390c3bb91a6a02788e4e95542f99c1b3173de7070dbb222b5411461dc14d0f36c035742f31d6adb883efad686d9c85bd7c6a5a591b5b18581b\"}",
  "pricingPreview": {
    "standard": {
      "tier": 0,
      "discountBps": 0,
      "discountAmount": "0",
      "paidAmount": "3000000000000000000000"
    },
    "studentSbt": {
      "tier": 1,
      "discountBps": 1000,
      "discountAmount": "300000000000000000000",
      "paidAmount": "2700000000000000000000"
    }
  }
}
```

- `qrPayload` chính là `JSON.stringify(envelope)` không khoảng trắng thừa; đảm bảo khi parse lại (`JSON.parse(qrPayload)`) sẽ cho ra cùng `envelope` và cùng EIP-712 `digest`.

---

### 3.2. `GET /api/invoices/:invoiceId` — Xem trạng thái và biên nhận (`B02`, `B04`)

POS (`/pos`) dùng endpoint này để poll trạng thái hóa đơn (chu kỳ đề xuất: `2000ms`, tăng dần backoff khi gặp lỗi mạng). Sinh viên (`/student`) cũng có thể gọi để kiểm tra hóa đơn đã được thanh toán hay chưa.

- **Path param:** `invoiceId` (`bytes32` hex `0x...`).
- **Query param tùy chọn:** `?txHash=0x...` — khi trình duyệt đã có `txHash` từ ví hoặc người vận hành đối chiếu thủ công, backend có thể gọi `eth_getTransactionReceipt` cho `txHash` đó bên cạnh việc đọc trạng thái/log của `invoiceId`.

#### Các trạng thái vòng đời (`InvoiceLifecycleStatus`)

| Giá trị `status` | HTTP Status | Ý nghĩa và hành vi UI |
| --- | --- | --- |
| `"pending"` | `200 OK` | Hóa đơn đang còn hạn (`now <= expiresAt`) và chưa có biên nhận on-chain được xác minh. UI hiển thị đồng hồ đếm ngược hoặc trạng thái chờ xác nhận giao dịch |
| `"paid"` | `200 OK` | Backend đã xác minh receipt thành công (`status = 0x1`) và sự kiện `InvoicePaid` khớp hóa đơn trên chain `20261`. UI hiển thị biên nhận hoàn tất và khóa nút thanh toán lại |
| `"expired"` | `200 OK` | Đã quá `expiresAt` (`now > expiresAt`) mà chưa có receipt hợp lệ. UI ngừng cho phép ký và hướng dẫn tạo hóa đơn mới trên POS |
| `"rpc-error"` | `503 Service Unavailable` | Backend tạm thời không đọc được RPC hoặc RPC đang trỏ sai chain. Trả kèm `lastKnownStatus` để UI giữ trạng thái đã biết và hiển thị cảnh báo kết nối |

#### Response khi đang chờ thanh toán (`status = "pending"`)

```json
{
  "invoiceId": "0x7dec24e2691f51c0bc1822acf25d4b07c5bd73ed5d641cc604f22eead02e69b1",
  "status": "pending",
  "envelope": {
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
  },
  "receipt": null,
  "updatedAt": 1794142510
}
```

#### Response khi đã xác minh biên nhận (`status = "paid"`)

```json
{
  "invoiceId": "0x7dec24e2691f51c0bc1822acf25d4b07c5bd73ed5d641cc604f22eead02e69b1",
  "status": "paid",
  "envelope": {
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
  },
  "receipt": {
    "invoiceId": "0x7dec24e2691f51c0bc1822acf25d4b07c5bd73ed5d641cc604f22eead02e69b1",
    "invoiceCode": "INV-20261108-PARKING-0001",
    "chainId": 20261,
    "contractAddress": "0x0000000000000000000000000000000000020261",
    "txHash": "0x9b5a6c7d8e9f00112233445566778899aabbccddeeff00112233445566778899",
    "blockNumber": 128,
    "logIndex": 0,
    "payer": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "merchant": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "category": "0xe3415db38bf7529604e320f58333c9ff6b278ff38b3391db9da4273c7be086eb",
    "originalAmount": "3000000000000000000000",
    "discountAmount": "300000000000000000000",
    "paidAmount": "2700000000000000000000",
    "tier": 1,
    "gasUsed": "68420",
    "effectiveGasPrice": "25000000000",
    "verifiedAt": 1794142525
  },
  "updatedAt": 1794142525
}
```

## 4. Điều kiện xác minh Receipt tại Backend (`B02`, `B04`)

`receipt.service.ts` chỉ được chuyển trạng thái hóa đơn sang `"paid"` khi thỏa mãn **đồng thời tất cả** các điều kiện sau:

1. **Đúng mạng:** `eth_chainId` từ RPC trả về `0x4f25` (`20261`). Nếu RPC trả sai mạng hoặc lỗi kết nối, trả mã lỗi `WRONG_CHAIN` hoặc `RPC_UNAVAILABLE`.
2. **Giao dịch thành công:** `receipt.status === "0x1"`. Nếu `receipt.status === "0x0"` (revert), giữ hóa đơn ở trạng thái `"pending"` (nếu còn hạn) hoặc `"expired"` (nếu đã hết hạn) và báo `TX_REVERTED` khi truy vấn theo `txHash` đó. Nếu `receipt.status === "0x1"` nhưng log không chứa sự kiện `InvoicePaid` hợp lệ của hóa đơn này (bước 3–5 bên dưới), giữ nguyên hóa đơn ở trạng thái `"pending"` (hoặc `"expired"` nếu đã quá hạn) và trả mã lỗi `RECEIPT_EVENT_MISMATCH` (`422`), không báo nhầm thành `TX_REVERTED`.
3. **Đúng hợp đồng phát sự kiện:** `log.address` (so sánh không phân biệt hoa thường) phải khớp với `envelope.domain.verifyingContract`. Sự kiện phát ra từ hợp đồng giả mạo bị bỏ qua hoàn toàn.
4. **Đúng chữ ký sự kiện (`topic0`):**
   - `keccak256("InvoicePaid(bytes32,address,address,bytes32,uint256,uint256,uint256,uint8)")`
   - `topics[1]` khớp `invoice.invoiceId`
   - `topics[3]` khớp `invoice.merchant` (dạng 32-byte padded address)
5. **Khớp dữ liệu trong `data` của log:**
   - `category === invoice.category`
   - `originalAmount === BigInt(invoice.amount)`
   - `paidAmount + discountAmount === originalAmount`
   - Nếu `tier === 1`: `discountAmount === (originalAmount * 1000n) / 10000n` và `paidAmount === originalAmount - discountAmount`.
   - Nếu `tier === 0`: `discountAmount === 0n` và `paidAmount === originalAmount`.
6. **Chống thông báo lặp (Idempotency):** Khi hóa đơn đã chuyển sang `"paid"`, backend lưu lại đối tượng `receipt` gắn với `invoiceId`. Mọi lần gọi `GET /api/invoices/:invoiceId` sau đó trả về ngay kết quả đã lưu mà không phát sinh sự kiện mới.

## 5. Cấu trúc phản hồi lỗi và Bảng mã lỗi chuẩn

Mọi phản hồi lỗi HTTP từ Backend (và trạng thái lỗi tương ứng trên Frontend) đều dùng chung cấu trúc JSON:

```json
{
  "error": {
    "code": "INVOICE_EXPIRED",
    "message": "Hóa đơn đã quá thời hạn thanh toán (300 giây).",
    "retryable": false,
    "nextStep": "Tạo hóa đơn mới trên màn hình POS và quét lại mã QR."
  }
}
```

### Bảng mã lỗi chuẩn toàn hệ thống

| Mã lỗi (`error.code`) | HTTP Status | Nguồn phát sinh / Custom Error Solidity tương ứng | Thông điệp tiếng Việt chuẩn (`message`) | Hành động tiếp theo (`nextStep`) |
| --- | --- | --- | --- | --- |
| `INVALID_REQUEST` | `400` | Request thiếu trường bắt buộc hoặc sai kiểu dữ liệu | Dữ liệu yêu cầu không hợp lệ hoặc bị thiếu. | Kiểm tra lại thông tin dịch vụ và thử lại. |
| `UNKNOWN_SERVICE_OR_MERCHANT` | `400` | `merchantId`/`serviceId` ngoài danh mục demo; hoặc `InvalidMerchantOrCategory` trên contract | Điểm thu hoặc dịch vụ không nằm trong danh sách được phép. | Chọn dịch vụ hợp lệ từ menu demo trên POS. |
| `INVALID_QR_PAYLOAD` | `400` | Chuỗi QR không phải JSON hợp lệ, sai `schemaVersion` hoặc thiếu trường | Mã QR không đúng định dạng hóa đơn IntraCampus. | Quét lại mã QR trên màn hình POS hoặc sao chép nguyên văn chuỗi QR. |
| `INVALID_SIGNATURE` | `400` | Chữ ký EIP-712 không khớp `signer`, hoặc `amount`/`domain` bị sửa (`InvalidSignature`) | Chữ ký hóa đơn không hợp lệ hoặc dữ liệu đã bị thay đổi. | Không ký giao dịch; yêu cầu POS tạo hóa đơn mới. |
| `INVOICE_NOT_FOUND` | `404` | `invoiceId` không tồn tại trên POS API | Không tìm thấy hóa đơn cần tra cứu. | Kiểm tra lại mã hóa đơn hoặc tạo hóa đơn mới trên POS. |
| `INVOICE_ALREADY_PAID` | `409` | Hóa đơn đã có biên nhận hợp lệ hoặc revert `InvoiceAlreadyPaid` trên contract | Hóa đơn này đã được thanh toán trước đó. | Không gửi lại giao dịch; đối chiếu biên nhận đã có trên màn hình POS. |
| `INVOICE_EXPIRED` | `410` | `now > expiresAt` hoặc revert `InvoiceExpired` trên contract | Hóa đơn đã quá thời hạn thanh toán (300 giây). | Tạo hóa đơn mới trên màn hình POS và quét lại mã QR. |
| `INCORRECT_PAYMENT_AMOUNT` | `422` | `msg.value` khác `paidAmount` (`IncorrectPaymentAmount` trên contract) | Số tiền gửi lên hợp đồng không khớp mức cần thanh toán. | Tải lại bản xem trước hóa đơn để cập nhật đúng mức ưu đãi SBT trước khi ký. |
| `TX_REVERTED` | `422` | `receipt.status === "0x0"` (giao dịch bị revert trên chuỗi) | Giao dịch trên chuỗi bị từ chối (revert), chưa thanh toán. | Kiểm tra số dư CAMPUS, hạn hóa đơn và thử lại nếu hóa đơn còn hạn. |
| `RECEIPT_EVENT_MISMATCH` | `422` | `receipt.status === "0x1"` nhưng không có sự kiện `InvoicePaid` từ `verifyingContract` khớp `invoiceId`, `merchant` và số tiền | Giao dịch đã thực thi nhưng không chứa biên nhận thanh toán hợp lệ cho hóa đơn này. | Giữ hóa đơn ở trạng thái chờ; kiểm tra lại đúng mã giao dịch (`txHash`) của lần thanh toán hóa đơn này. |
| `WRONG_CHAIN` | `400` / `503` | Ví sinh viên hoặc RPC backend không ở trên chain `20261` | Đang kết nối sai mạng (yêu cầu IntraCampus L1 — Chain ID 20261). | Chuyển ví hoặc cấu hình RPC về mạng IntraCampus L1 (20261) rồi thử lại. |
| `RPC_UNAVAILABLE` | `503` | Không kết nối được RPC hoặc quá thời gian chờ (`timeout`) | Không kết nối được tới nút mạng IntraCampus L1 để xác minh dữ liệu. | Giữ nguyên trạng thái hiện tại, kiểm tra kết nối RPC và thử đọc lại. |
