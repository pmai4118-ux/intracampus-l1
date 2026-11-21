# Chạy IntraCampus L1 trên máy cá nhân

Tài liệu này hướng dẫn chạy giao diện POS/Student và API với profile local `20261`. Nó không cấu hình RPC online trên VM. Để chạy web online qua Vercel và backend/RPC trên GCP, dùng [runbook cloud](cloud-deployment.md). Luồng hóa đơn thật cần RPC L1 và địa chỉ triển khai do nhóm bàn giao; nếu chưa có cấu hình đó, chỉ có thể mở giao diện và xem bản minh họa.

## 1. Yêu cầu

- Windows PowerShell, Node.js 24.x và pnpm 11.25.0.
- Checkout source mới nhất đã được merge:

```powershell
git fetch origin
git switch main
git pull --ff-only
```

Nếu đang làm việc trên một nhánh task, giữ nguyên nhánh đó và không chạy các lệnh trên giữa chừng.

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

### Nối Core với L1 local trên Windows/WSL2

Phần này dùng L1 local đã được tạo và đang chạy trong WSL2. Không chạy lại lệnh `avalanche blockchain create` hoặc `deploy` chỉ để mở ứng dụng: tạo lại chain sẽ đổi lịch sử và có thể làm manifest/địa chỉ contract cũ không còn hợp lệ.

Mở PowerShell và kiểm tra distro/công cụ. Nếu tên distro hoặc đường dẫn `cast` trên máy khác, thay cho đúng môi trường của bạn:

Chạy các khối PowerShell trong cùng một cửa sổ để giữ `$Distro` và `$RpcUrl`.

```powershell
$Distro = 'IntraCampus-L01-Ubuntu'
wsl.exe --list --quiet
wsl.exe -d $Distro -- /root/.foundry/bin/cast --version
```

Đặt RPC URL đúng theo lần `avalanche blockchain deploy` hiện tại. Đây là endpoint CLI báo cho chain local đang dùng ngày 18/11/2026; nếu CLI `network status` báo blockchain ID khác, thay URL bằng kết quả mới. Không tái sử dụng ID cũ sau khi tạo chain khác:

```powershell
$RpcUrl = 'http://127.0.0.1:9654/ext/bc/2fruduRhAJ8vHD3btM6o59hyhJaLW8xaVJsxhbZga5kJkUABkL/rpc'
$Body = @{ jsonrpc = '2.0'; id = 1; method = 'eth_chainId'; params = @() } | ConvertTo-Json -Compress
$Probe = Invoke-RestMethod -Uri $RpcUrl -Method Post -ContentType 'application/json' -Body $Body
if ($Probe.result -ne '0x4f25') { throw "Sai chain ID: $($Probe.result); cần 0x4f25 (20261)." }
$Probe.result
```

Kết quả phải là `0x4f25`. Nếu PowerShell không kết nối được, kiểm tra node L1 còn chạy và RPC URL có đúng blockchain ID không. Có thể kiểm tra cùng endpoint bằng `cast` trong WSL:

```powershell
wsl.exe -d $Distro -- /root/.foundry/bin/cast rpc --rpc-url $RpcUrl eth_chainId
```

Trong Core Wallet trên Chrome:

1. Chọn hoặc tạo tài khoản **demo riêng**. Không dùng tài khoản mainnet/tiền thật cho chain local.
2. Mở **Settings → Networks → Custom → Add** (hoặc sửa mục IntraCampus L1 đã có).
3. Điền network name `IntraCampus L1`, RPC URL bằng `$RpcUrl`, Chain ID `20261`, Token symbol `CAMPUS`, Token name `CAMPUS token`; explorer URL có thể để trống.
4. Lưu rồi chọn IntraCampus L1. Ví cần đang ở đúng account demo và đúng chain trước khi mở app.

`CAMPUS` là đồng gốc của L1 local, cũng là đồng trả gas. Cấu hình symbol/token name trong mạng là phần cần thiết để Core hiển thị đồng gốc; đừng nhập private key/seed phrase vào trang web, file `.env`, QR hoặc chat. Chỉ sao chép địa chỉ công khai của tài khoản demo. Nếu Core không hiện CAMPUS, đối chiếu network/RPC/chain ID trước; đừng tự thêm một token ERC-20 trừ khi manifest của môi trường đó có contract token ERC-20 được xác nhận.

### Kiểm tra số dư và nạp ví demo bằng PowerShell

Lấy địa chỉ công khai của Student/Librarian từ Core rồi gán vào PowerShell. Dùng RPC đã kiểm tra ở trên:

```powershell
$Student = '0xDIA_CHI_STUDENT_TREN_CORE'
$Librarian = '0xDIA_CHI_LIBRARIAN_TREN_CORE'
wsl.exe -d $Distro -- /root/.foundry/bin/cast balance --rpc-url $RpcUrl $Student
wsl.exe -d $Distro -- /root/.foundry/bin/cast balance --rpc-url $RpcUrl $Librarian
```

`cast balance` trả số dư CAMPUS theo wei (18 chữ số thập phân). Để nạp, dùng **funder demo riêng** đã được cấp CAMPUS và import dưới dạng keystore Foundry; tên ví bên dưới là ví dụ:

```powershell
wsl.exe -d $Distro -- /root/.foundry/bin/cast wallet import intracampus-funder --interactive
wsl.exe -d $Distro -- /root/.foundry/bin/cast wallet address --account intracampus-funder
```

Lệnh import hỏi khóa qua prompt ẩn và mật khẩu keystore; chỉ nhập khóa của funder demo riêng từ nguồn tin cậy. Không nhập khóa/seed phrase của tài khoản Student/Librarian trong Core. Nếu chưa được cấp khóa funder và ví này chưa có CAMPUS, dừng trước lệnh gửi tiền; dùng quy trình B03 ở [docs/demo-accounts.md](demo-accounts.md) hoặc nhờ người giữ funder demo riêng nạp.

Đối chiếu địa chỉ funder, Student/Librarian, chain `20261` và số dư trước khi gửi. Các lệnh sau tạo giao dịch thật trên L1 local, hỏi mật khẩu keystore trong terminal và trừ gas từ funder:

```powershell
wsl.exe -d $Distro -- /root/.foundry/bin/cast send --rpc-url $RpcUrl --chain 20261 --account intracampus-funder --value 3000ether $Student
wsl.exe -d $Distro -- /root/.foundry/bin/cast send --rpc-url $RpcUrl --chain 20261 --account intracampus-funder --value 1ether $Librarian
```

Chỉ chạy nếu cần nạp; nếu ví đã đủ tiền thì bỏ qua. `3000ether` ở đây là 3.000 CAMPUS (không phải AVAX). Dùng funder riêng, không thay bằng khóa deployer, POS signer hoặc grant issuer. Nếu chưa có funder riêng, dừng tại đây và dùng quy trình seed an toàn trong [docs/demo-accounts.md](demo-accounts.md); không lấy/chép khóa từ Core hoặc repo. `cast send` in transaction hash và receipt; có thể đối chiếu lại bằng:

```powershell
$TxHash = '0xHASH_DO_CAST_SEND_TRA_VE'
wsl.exe -d $Distro -- /root/.foundry/bin/cast receipt --rpc-url $RpcUrl $TxHash
wsl.exe -d $Distro -- /root/.foundry/bin/cast balance --rpc-url $RpcUrl $Student
```

Sau đó chạy `pnpm rpc:check`, rồi mở [http://127.0.0.1:4000/api/network](http://127.0.0.1:4000/api/network). `rpc:check` kiểm tra chain ID; trước giao dịch demo cũng xem `latestBlock`/`headAgeSeconds`. Nếu head cũ hơn 300 giây, app sẽ chặn thao tác để tránh ký invoice đã hết hạn. Xem [mục chẩn đoán Library, FOOD và gửi xe](#chẩn-đoán-local-library-food-và-gửi-xe-17112026). Không reset chain hoặc bỏ qua giới hạn freshness.

### Giữ nguyên setup khi tắt và mở lại máy

Core giữ network/account trong profile Chrome; WSL giữ distro, keystore Foundry và dữ liệu node dưới Linux home. Không xóa profile Chrome, unregister distro, hoặc xóa `~/.avalanche-cli`, `~/.avalanchego`, `~/.foundry/keystores`, `.env` hay manifest deployment.

Trước khi tắt Windows, lưu snapshot hiện tại bằng lệnh `network stop` của Avalanche CLI. CLI bản `1.9.4` đang ở `/root/bin/avalanche` trong distro này, nên gọi đường dẫn đầy đủ:

```powershell
wsl.exe -d $Distro -- /root/bin/avalanche --skip-update-check network stop
```

Kết quả phải xác nhận local network đã dừng. `network stop` lưu trạng thái đang chạy để lần sau `network start` khôi phục; **không** dùng `network clean`, vì lệnh đó xóa state của local network. Đây là cách snapshot được mô tả trong [tài liệu chính thức của Avalanche CLI](https://github.com/ava-labs/avalanche-cli#snapshots-usage-for-local-networks).

Sau khi bật máy lại, mở PowerShell, gán lại `$Distro` và `$RpcUrl` như các bước trên, rồi khôi phục đúng snapshot:

```powershell
$Distro = 'IntraCampus-L01-Ubuntu'
$RpcUrl = 'http://127.0.0.1:9654/ext/bc/2fruduRhAJ8vHD3btM6o59hyhJaLW8xaVJsxhbZga5kJkUABkL/rpc'
$Body = @{ jsonrpc = '2.0'; id = 1; method = 'eth_chainId'; params = @() } | ConvertTo-Json -Compress
wsl.exe -d $Distro -- /root/bin/avalanche --skip-update-check network start
wsl.exe -d $Distro -- /root/bin/avalanche --skip-update-check network status
$Probe = Invoke-RestMethod -Uri $RpcUrl -Method Post -ContentType 'application/json' -Body $Body
if ($Probe.result -ne '0x4f25') { throw "Sai chain ID: $($Probe.result); cần 0x4f25 (20261)." }
```

Khi RPC trả `0x4f25`, vào thư mục repo, chạy `pnpm rpc:check` rồi `pnpm dev`. Không cần tạo/deploy chain, cài lại dependencies hay import lại ví mỗi lần khởi động Windows. Chỉ chạy `pnpm install --frozen-lockfile` khi dependencies của branch thay đổi. Nếu PowerShell báo không kết nối được RPC, kiểm tra `wsl.exe --list --quiet`, `network status` và đúng blockchain ID trước; đừng chạy `blockchain deploy` để “sửa” trạng thái.

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

## Chẩn đoán local Library, FOOD và gửi xe (17/11/2026)

Mở đúng http://127.0.0.1:3000 khi LIBRARY_AUTH_ORIGIN dùng host này. Cookie đăng nhập không được chia sẻ với localhost. Library, FOOD và Student payment dùng cùng phiên ví đã ký đăng nhập; chữ ký login không chuyển tiền và không tốn gas.

Sau khi pnpm rpc:check trả ready, xem latestBlock/headAgeSeconds trong /api/network hoặc trang gốc. ready xác nhận chain ID đúng, không xác nhận freshness nghiệp vụ. Node local có thể không tạo block khi không có giao dịch: nếu head cũ hơn cấu hình, giữ nguyên giới hạn, xác minh node/đồng hồ rồi dùng giao dịch demo thực sự từ ví funding riêng. Không dùng mining RPC giả, không reset/deploy lại. Nếu vừa nạp tiền mà head vẫn cũ, dừng để kiểm tra endpoint ví và backend cùng blockchain.

Trước demo, kiểm tra balance/hold/SBT hiện tại. Parking 3.000 CAMPUS, tier 1 giảm 300 còn 2.700; Library cọc 50. Student phải có đủ native cho cả hai khoản và gas; FOOD 1.000 lấy từ vault, Student chỉ trả gas. Librarian cần native cho gas approve. Nạp từ ví riêng, không dùng khóa role POS/grant issuer. Core hiển thị phí trước khi ký; số dư thay đổi không thay thế receipt.

1. Student kết nối chain 20261 tại /student/library, bấm Ký đăng nhập thư viện và tự chấp thuận trong Core; sau đó đọc sách/account status. 401 khi chưa có session là đúng; 503 STALE_CHAIN_STATE cần xử lý head.
2. Mượn sách: tạo một request, xem cọc 50 rồi ký deposit. Sau receipt deposit, Librarian đăng nhập tại /staff/library và ký approve. Chỉ ACTIVE sau event đã xác minh. Dùng profile trình duyệt riêng hoặc đăng nhập lại khi đổi ví Student/Librarian vì session cookie dùng chung origin.
3. FOOD: trở lại Student đúng ví/session, xem balance grant thật rồi chi một lần 1.000 FOOD. Kiểm GrantSpent và balance sau chi; không chạy seed:grants --apply lại. Baseline 5.000 sẽ còn 4.000 sau thành công.
4. Parking: POS tạo invoice mới khi head đủ mới; Student xem quote, ký payInvoice một lần trong Core; POS/Student đối chiếu cùng invoice/hash và InvoicePaid. Không sử dụng invoice cũ đã hết hạn.

Nếu transaction pending/unknown, giữ journal/request/invoice/hash và tra receipt; không xóa storage hoặc gửi lại. Trước mọi bước gửi tiếp, kiểm tra state hiện có để tránh lặp. Các chữ ký và xác nhận Core do người dùng thao tác. Ghi evidence công khai gồm chain, contract, request/invoice, hash, receipt/event; không ghi key, cookie hay chữ ký login.

Test CLI grants dùng fixture manifest riêng; Next proxy test dùng output/tsconfig riêng trong frontend/.next-tests và cổng động, nên không cần dừng dev server hoặc thay deployment manifest để chạy pnpm test.
