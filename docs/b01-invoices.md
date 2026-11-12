# B01 · Tạo hóa đơn và ký QR

`POST /api/invoices` nhận hai trường `merchantId` và `serviceId`. Menu hiện có là `parking-demo` / `parking-single`: giá gốc 3.000 CAMPUS, tier 1 xem trước 2.700 CAMPUS. Server từ chối trường ngoài schema, kể cả `amount` và `signer`; giá cuối vẫn do contract quyết định khi thanh toán.

## Cấu hình và chạy thử

Dùng Node 24, pnpm 11.25.0. Tạo `backend/.env` theo `.env.example`, cấu hình:

| Biến | Nguồn / trách nhiệm |
| --- | --- |
| `INTRACAMPUS_RPC_URL` | RPC L02, phải trả chain 20261 |
| `CAMPUS_PAYMENT_REGISTRY_ADDRESS` | Verifier thật từ L06 |
| `CAMPUS_PAYMENT_DEPLOYMENT_BLOCK` | Block triển khai của cùng verifier, B02 dùng để quét receipt |
| `PARKING_MERCHANT_ADDRESS` | Ví merchant demo nhận CAMPUS; L06/admin L04 phải cho phép cặp merchant / `keccak256("PARKING")` |
| `POS_SIGNER_PRIVATE_KEY` | Khóa demo chỉ ở backend, địa chỉ phải khớp `posSigner()` của verifier |
| `INVOICES_DB_PATH` | Tùy chọn, mặc định `backend/data/invoices.sqlite`; giữ volume bền vững |

Không dùng verifier/merchant fixture như cấu hình mặc định. Thiếu verifier hoặc merchant trả 503 `RPC_UNAVAILABLE`; khóa thiếu/sai hoặc không khớp signer trả 400 `INVALID_SIGNATURE`. Health check vẫn dùng được khi chưa cấu hình thanh toán. Các giá trị lỗi trả về không chứa khóa, URL RPC hoặc lỗi nội bộ.

Chạy `pnpm rpc:check` trước khi làm việc với L1, rồi `pnpm --filter @intracampus/backend start`. Ví dụ PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/api/invoices `
  -ContentType application/json `
  -Body '{"merchantId":"parking-demo","serviceId":"parking-single"}'
```

Response 201 có `invoiceId`, `status: pending`, `envelope`, `qrPayload`, `pricingPreview`, `transaction: null` theo P02. UUID trong `invoiceCode` giúp không trùng sau restart hoặc request đồng thời; `invoiceId = keccak256(invoiceCode)`. `issuedAt` lấy từ block chain, `expiresAt = issuedAt + 300`. Backend đọc chain ID và `posSigner()` trước từng lần phát hành; đọc signer tại block đã dùng lấy timestamp. SQLite phải lưu thành công trước 201. POST lỗi không tự thử lại; một lần POST mới tạo một hóa đơn mới.

## Đổi merchant và xoay khóa

Signer là signer POS chung, tách khỏi ví merchant nhận tiền. Đổi merchant: cập nhật `PARKING_MERCHANT_ADDRESS` và allowlist merchant/category trên registry theo L04, rồi khởi động lại backend. Không cần đổi signer chỉ vì đổi merchant.

`posSigner` của L04 là immutable. Xoay khóa cần L06 triển khai registry mới với signer mới; bàn giao địa chỉ/block, cập nhật đồng bộ backend và cấu hình tin cậy của U03/U04, rồi khởi động lại. Giữ registry cũ có nghĩa chữ ký cũ vẫn chịu chính sách của registry cũ; vô hiệu merchant/category cũ nếu cần dừng các hóa đơn đang tồn tại. Không thay riêng khóa backend rồi tiếp tục dùng verifier cũ. Lưu khóa demo ngoài Git/log/QR; không dùng ví có tài sản thật.

## Kiểm chứng và bằng chứng

`pnpm test` bao gồm HTTP thật qua loopback, RPC giả lập và SQLite thật: request sai/ngoài menu, sửa giá, chữ ký/digest/QR, ID đồng thời, đọc lại bằng GET B02, mở lại SQLite, sai chain/signer, RPC mất/phản hồi lỗi và lỗi lưu dữ liệu. Chữ ký xác định của production `invoiceTypes` khớp digest và signature trong fixture P02 mà Solidity dùng chung.

Tái tạo mẫu HTTP đã loại bỏ khóa, chạy từ thư mục gốc trên PowerShell:

```powershell
$env:B01_EVIDENCE_PATH = Join-Path (Get-Location) 'docs/fixtures/b01-create-response.json'
pnpm --filter @intracampus/backend test:b01:evidence
Remove-Item Env:B01_EVIDENCE_PATH
```

Mẫu [request/response](fixtures/b01-create-response.json) được sinh từ service và HTTP route thật với RPC giả lập. Mỗi lần chạy có UUID/chữ ký mới. Không có giao dịch on-chain trong bằng chứng HTTP này, không phải kết quả Avalanche L1.

Đã chạy L04 từ main commit `06f2877c0b8f4d4ec8ea129695146c01e58fe867` trong thư mục tạm, Foundry 1.7.1 / Solc 0.8.24. Test `testExpiredInvoiceRejectedInQuoteAndPay` đạt trên EVM local. [Bằng chứng tích hợp local](fixtures/b01-local-evidence.json) còn ghi invoice thực từ POST B01 được L04 thanh toán, GET B02 xác minh receipt, và invoice thứ hai bị cả quote/pay từ chối `InvoiceExpired` khi timestamp bằng `expiresAt + 1`. Kiểm tra artifact/source qua loader L04 trước khi deploy local; không dùng artifact cũ.

Để tái tạo: build source L04 bằng `forge build` trong `contracts/`, khởi động Anvil loopback `127.0.0.1:18547`, chain ID `20261`, dùng bộ tài khoản demo mặc định. Chạy từ gốc repo:

```powershell
pnpm --filter @intracampus/backend test:b01:local C:/duong-dan-source-L04/contracts C:/duong-dan-output/b01-local-evidence.json
```

Script chỉ chấp nhận endpoint loopback cố định có client version Anvil và chain 20261. Nó dùng các tài khoản demo mở khóa, tạo contract và giao dịch local, không đọc khóa môi trường. Thư mục source L04 cần có dependency ethers để loader chạy (thông thường là checkout/worktree của monorepo đã cài pnpm). Dừng Anvil sau kiểm tra. Test local này chạy thủ công khi có Foundry; không đưa vào suite HTTP mặc định.

## Điểm nối và giới hạn nghiệm thu

- B01 được phát triển trên PR B02 #9 (`f8b905c`), dùng nguyên `InvoiceRepository.create(envelope)`, `HttpInvoiceRpc` và GET của B02. Không merge PR phụ thuộc. Khi đưa lên review, so diff B01 với nhánh B02; nếu B02 đổi repository/router cần cập nhật điểm nối trước khi tích hợp main.
- U03 gọi POST, hiển thị QR từ `qrPayload`; kiểm tra signer/verifier tin cậy và preflight theo P02. Metadata có thể bị sửa độc lập chữ ký nên frontend không được coi QR là nguồn tin cậy cho tên/giá ngoài các trường được ký.
- B04 dùng cùng DB và deployment cho POST/GET; giữ lịch poll/backoff và hash chưa xác minh. B01 không thực hiện thanh toán, không tự gửi lại giao dịch.
- Chưa có RPC/deployment L06 được bàn giao cho phiên này: chưa nghiệm thu trên Avalanche L1. Chữ ký/thanh toán/expiry đã kiểm chứng với L04 trên Anvil local; cần chạy tiếp trên deployment thật khi tích hợp.
