# Chạy IntraCampus L1 trên máy cá nhân

Tài liệu này hướng dẫn chạy giao diện POS/Student và API. Luồng hóa đơn thật cần RPC L1 và địa chỉ triển khai do nhóm bàn giao; nếu chưa có cấu hình đó, chỉ có thể mở giao diện và xem bản minh họa.

## 1. Yêu cầu

- Windows PowerShell, Node.js 24.x và pnpm 11.25.0.
- Nhánh có code U03. Khi PR #15 chưa được merge vào `main`, lấy nhánh PR:

```powershell
git fetch origin
git switch codex/U03-student-payment
```

Nếu bạn đang ở đúng nhánh rồi thì không cần chạy lại lệnh chuyển nhánh.

Kiểm tra công cụ:

```powershell
node --version
pnpm --version
```

Nếu `node` hoặc `pnpm` không được nhận diện, cài Node.js 24 LTS, mở PowerShell mới, rồi cài đúng pnpm mà repo đang ghim:

```powershell
npm install --global pnpm@11.25.0
```

Tại thư mục gốc repo, cài dependencies:

```powershell
pnpm install --frozen-lockfile
```

Nếu đường dẫn thư mục chứa dấu ngoặc vuông như `[pet-project]`, dùng `-LiteralPath` khi vào thư mục trong PowerShell:

```powershell
Set-Location -LiteralPath 'C:\duong-dan-cua-ban\intracampus-l1'
```

## 2. Tạo cấu hình local

Tạo file môi trường nếu chúng chưa tồn tại. Lệnh này giữ nguyên file đã có:

```powershell
if (!(Test-Path backend/.env)) { Copy-Item backend/.env.example backend/.env }
if (!(Test-Path frontend/.env.local)) { Copy-Item frontend/.env.local.example frontend/.env.local }
```

Mở hai file để điền cấu hình:

```powershell
notepad backend/.env
notepad frontend/.env.local
```

Không đưa các file `.env` này lên Git.

### Backend: `backend/.env`

| Biến | Giá trị cần điền |
| --- | --- |
| `INTRACAMPUS_RPC_URL` | RPC của IntraCampus L1 do nhóm cung cấp; phải trả chain ID `20261`. |
| `CAMPUS_PAYMENT_REGISTRY_ADDRESS` | Địa chỉ `CampusPaymentRegistry` từ manifest L06. |
| `CAMPUS_PAYMENT_DEPLOYMENT_BLOCK` | Block triển khai của chính contract đó, lấy từ L06. |
| `POS_SIGNER_PRIVATE_KEY` | Khóa server ký hóa đơn EIP-712 ngoài chain; signer phải khớp với cấu hình hợp đồng. Giữ riêng ở backend. |
| `PARKING_MERCHANT_ADDRESS` | Địa chỉ ví nhận CAMPUS của dịch vụ bãi xe. |

`INVOICES_DB_PATH` có thể để trống khi chạy local; ứng dụng dùng mặc định trong `backend/data/`. Các biến `SEED_*` chỉ cần khi nhóm chạy lệnh seed demo, không cần để mở web/API.

### Frontend: `frontend/.env.local`

| Biến | Giá trị cần điền |
| --- | --- |
| `BACKEND_URL` | Giữ `http://127.0.0.1:4000` khi backend chạy trên cùng máy. |
| `NEXT_PUBLIC_INTRACAMPUS_RPC_URL` | RPC public của IntraCampus L1, cùng chain `20261`. Không dùng URL có API key bí mật. |
| `NEXT_PUBLIC_STUDENT_SBT_ADDRESS` | Địa chỉ SBT từ manifest L06. |
| `NEXT_PUBLIC_CAMPUS_PAYMENT_REGISTRY_ADDRESS` | Địa chỉ payment registry từ cùng manifest L06. |
| `NEXT_PUBLIC_CAMPUS_POS_SIGNER_ADDRESS` | Địa chỉ role POS signer từ cùng manifest L06. |

Các biến `NEXT_PUBLIC_*` sẽ được đưa vào frontend, nên chỉ điền RPC URL không có secret và các địa chỉ contract công khai. Không điền private key vào đây.

L1 cần có cặp merchant/category bãi xe được bật trong registry. Không dùng Fuji C-Chain `43113`, AVAX hay faucet Fuji thay cho mạng và CAMPUS của dự án.

## 3. Kiểm tra RPC và khởi động

Từ thư mục gốc repo, kiểm tra backend RPC trước:

```powershell
pnpm rpc:check
```

Kết quả phải báo mạng sẵn sàng với chain ID `20261`. Sau đó chạy cả backend và frontend:

```powershell
pnpm dev
```

Để dừng, bấm `Ctrl+C` trong cửa sổ PowerShell đang chạy lệnh.

Mở các địa chỉ sau:

- POS: <http://127.0.0.1:3000/pos>
- Student: <http://127.0.0.1:3000/student>
- Backend health check: <http://127.0.0.1:4000/healthz>
- API network check: <http://127.0.0.1:4000/api/network>

## 4. Chạy thử luồng U03

1. Mở `/pos`, chọn **POS thật**, rồi bấm **Tạo hóa đơn**. POS gọi backend B01 và hiện QR cùng payload để sao chép.
2. Mở `/student` trong trình duyệt có ví Core. Kết nối ví trên IntraCampus L1, chain `20261`.
3. Quét QR hoặc dán payload. Student kiểm tra hóa đơn với backend, rồi kiểm tra hạn, signer, trạng thái đã trả, quote SBT và mô phỏng `payInvoice` trên RPC.
4. Nếu preflight thành công, màn hình hiển thị giá gốc, mức giảm và CAMPUS cần trả.

U03 chỉ xác minh và mô phỏng; nó **không yêu cầu ví ký hoặc gửi giao dịch**. Phần sinh viên xác nhận và ký `payInvoice` thuộc U04. Không cần đăng nhập Builder Hub để chạy ứng dụng trên L1 đã có; Builder Hub chỉ dùng khi tạo L1 hoặc lấy Data API key.

## 5. Nếu chưa có RPC hoặc L06

Có thể chạy `pnpm dev` để mở giao diện. Backend cũng có health check khi chưa kết nối L1; POS thật không thể phát hành hóa đơn và Student không thể xác minh giá. Trên `/pos`, chọn **Xem bản minh họa** để xem giao diện fixture. Đây không phải giao dịch hoặc bằng chứng thanh toán thật.

## 6. Xử lý lỗi thường gặp

| Thông báo | Kiểm tra |
| --- | --- |
| `node` không được nhận diện | Cài Node.js 24 LTS, đóng/mở lại PowerShell hoặc VS Code, rồi thử `node --version`. |
| `pnpm` không được nhận diện | Chạy `npm install --global pnpm@11.25.0`, mở PowerShell mới, rồi thử `pnpm --version`. |
| `pnpm rpc:check` báo sai mạng hoặc không kết nối | Kiểm tra `INTRACAMPUS_RPC_URL`; endpoint phải thuộc L1 của nhóm và trả chain `20261`. |
| POS báo chưa tạo được hóa đơn | Kiểm tra RPC/deployment backend và signer trong `backend/.env`; signer phải trùng POS signer của contract. |
| Student không xác minh được hóa đơn | Kiểm tra ví Core đã kết nối đúng chain, các địa chỉ frontend khớp cùng manifest L06, RPC truy cập được và cặp merchant/category đã bật. |
| Cổng 3000 hoặc 4000 đã được dùng | Dừng tiến trình đang chiếm cổng rồi chạy lại `pnpm dev`. |
