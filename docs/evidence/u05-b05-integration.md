# U05 · Kiểm chứng sau khi B05 đã vào main

Ngày kiểm tra: 2026-11-13. B05 #16 đã vào main tại `ad3e05c`; nhánh U05 ghép
main bằng merge local `8ede41e`, giữ cả D017 / D018. Không đổi nghiệp vụ đã
sửa theo review, ABI/P02, contract hoặc backend grants. Không đưa prototype
Social Onchain vào repo; không push, merge PR, deploy hoặc cập nhật sprint.

## Kết quả hiện tại

| Kiểm tra | Môi trường và kết quả |
| --- | --- |
| `pnpm install --frozen-lockfile` | Node 24.22.1 / pnpm 11.25.0, lockfile không đổi |
| `pnpm typecheck` | Đạt backend/frontend/package chung |
| `pnpm test` mặc định | 411 pass / 0 fail / 1 skip B03 integration tùy chọn |
| `pnpm test` bật B03 local | 412 pass / 0 fail / 0 skip với ANVIL_BIN và SEED_SBT_ARTIFACT từ build hiện tại |
| `pnpm build` | Next.js production build đạt trên manifest canonical unconfigured |
| Foundry | fmt/build-force/test đạt; 69 pass, 0 fail |
| EVM/controller | 8 ca trên node Anvil tạm 20261, B01/B02/B05 HTTP và U04/U05 thật |
| Browser | 10 ca, 3 broadcast thật trên Anvil, không page error; provider ví được tiêm |
| `pnpm rpc:check` | Exit 1, `not-configured`, expectedChainId 20261; chưa có RPC L1 |

Foundry có hai cảnh báo lint block-timestamp hiện có trong StudentSBTIdentity
ở logic hạn thẻ; không sửa contract để tắt cảnh báo. Harness có thể in một
thông báo ethers thử lại khi Anvil vừa khởi động; sau đó xác nhận đúng chain
và chạy đầy đủ. Không có test thất bại bị bỏ qua.

Giữ toàn bộ regression `frontend/test/grants.test.ts`: receipt/event không
khớp, sai account/chain, dữ liệu trả muộn, storage lỗi và các ranh giới
prepared/unknown đều chạy lại trong bộ frontend 127 test. Lượt này bổ sung
kiểm chứng browser còn thiếu, không thêm unit test lặp lại implementation.

## Bằng chứng mới

[Controller/HTTP/EVM](../fixtures/u05-b05-integrated-local-evidence.json) có
hai mức giá 3.000/2.700, từ chối ký, mất phản hồi sau broadcast và khôi phục
không gửi lại, FOOD 5.000 → 4.000, cùng ba preflight chặn ví cá nhân, PARKING
và vượt số dư. Contract chạy artifact từ source được compiler xác minh; receipt
đến từ Anvil rồi được B05 kiểm tra, không tạo object receipt giả làm bằng chứng.

[Báo cáo browser](../../artifacts/u05-b05-integration/browser-report.json)
đi qua Student và proxy Next cùng origin, API B05 và contract Anvil thật:

- Đọc 5.000; số dư 0 của ví khác được phân biệt với lỗi đọc; tiền mũ/vượt số dư
  bị chặn, đổi account nhanh kết thúc ở beneficiary hiện tại.
- Sai chain chặn chi. Một ca HTTP 503 được tiêm rõ ràng để kiểm tra stale /
  retry; các ca thành công gọi API thật.
- Từ chối ví không broadcast. Khoản chi value 0 giảm grant 5.000 → 4.000,
  merchant tăng đúng 1.000; pending/confirmed qua reload không gửi lại.
- Web Lock thực tế chặn khôi phục prepared ở tab khác khi tab cũ còn giữ lock.
  Đóng tab cũ cho khôi phục mà không gửi; phải bấm chi mới mới broadcast.
- Mất hash sau broadcast thật giữ unknown qua reload và cả khi số dư đã đổi.
  Nhập đúng hash để xác minh, không tạo giao dịch khác.
- Registry thật gỡ merchant khiến nút chi bị chặn; grant giữ nguyên. Disconnect
  xóa danh tính ví và chặn khoản chi mới.

Account riêng của browser bắt đầu 5.000, chi thành 4.000. Account dùng ca
prepared đã chi một lần ở harness nên bắt đầu 4.000; chi mới sau reconciliation
còn 3.000. Ca unknown tiếp tục account browser từ 4.000 xuống 3.000. Báo cáo
không gọi các lượt recovery đó là một grant 5.000 mới.

Ảnh [trước chi](../../artifacts/u05-b05-integration/student-grant-before-mobile.png),
[pending](../../artifacts/u05-b05-integration/student-pending-mobile.png),
[sau chi](../../artifacts/u05-b05-integration/student-grant-after-mobile.png),
[desktop](../../artifacts/u05-b05-integration/student-grant-after-desktop.png),
[prepared đã khôi phục](../../artifacts/u05-b05-integration/student-prepared-reconciled.png)
và [unknown vẫn khóa](../../artifacts/u05-b05-integration/student-unknown-remains-blocked.png)
có nhãn EVM local. Viewport 390×844 / 1440×1000, không tràn ngang. Chưa phải
điện thoại vật lý hoặc Core thật.

Source copy nằm trong backend/data bị Git bỏ qua. Báo cáo lưu revision và
SHA-256 của GrantPanel, controller, wallet, proxy và loader. Riêng manifest
copy có deployed shape với địa chỉ Anvil để thử UI; API vẫn dùng local-anvil
và allowLocal trong harness. Hash manifest canonical trước/sau không đổi,
vẫn unconfigured. Không có khóa/raw signed transaction trong evidence.

## Tái hiện controller

Sau pnpm install và `forge build --force`, từ repo:

```powershell
$env:ANVIL_BIN = (Resolve-Path 'backend/data/b05-tools/anvil.exe').Path
node frontend/test/u04-u05-local-evidence.mjs backend/data/u05-new-controller.json
```

Output phải chưa tồn tại. Có thể dùng Anvil trên PATH thay biến ANVIL_BIN.
Thư mục backend/data/b05-tools là công cụ local, không phải binary được commit.
Không đặt output vào manifest canonical.

Để chạy cả B03 integration thay vì skip mặc định:

```powershell
$env:ANVIL_BIN = (Resolve-Path 'backend/data/b05-tools/anvil.exe').Path
$env:SEED_SBT_ARTIFACT = (Resolve-Path 'contracts/out/StudentSBTIdentity.sol/StudentSBTIdentity.json').Path
pnpm test
```

## Tái hiện browser

Harness có lifecycle chỉ dùng trong test: U05_BROWSER_FIXTURE_DIR phải nằm
dưới backend/data. Sau tám ca controller, harness seed một account Anvil riêng,
lưu config công khai rồi giữ API/RPC loopback. Route dừng fixture không tồn tại
trong ứng dụng production.

Ở terminal A, chọn một run mới:

```powershell
$env:ANVIL_BIN = (Resolve-Path 'backend/data/b05-tools/anvil.exe').Path
$env:U05_BROWSER_FIXTURE_DIR = Join-Path (Get-Location) 'backend/data/u05-new-run/browser'
node frontend/test/u04-u05-local-evidence.mjs backend/data/u05-new-run/controller.json
```

Sau fixture ready, terminal B:

```powershell
node frontend/test/prepare-u05-browser.mjs backend/data/u05-new-run/browser
cd backend/data/u05-new-run/browser/source
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --filter @intracampus/frontend build
pnpm --filter @intracampus/frontend start --port 3106
```

Offline cần dependency đã có trong pnpm store; máy mới cài dependencies ở repo
gốc trước. Preparer không sao chép operator .env, .git, .next hoặc node_modules.
Chỉ copy sinh public loopback RPC/BACKEND_URL và test manifest; không dùng
cấu hình production để vượt guard local-anvil.

Cài Python Playwright trong môi trường test riêng nếu chưa có; dùng Edge đã
cài. Từ repo chạy:

```powershell
python frontend/test/u05-b05-browser.py --help
python frontend/test/u05-b05-browser.py backend/data/u05-new-run/browser artifacts/u05-new-run --origin http://127.0.0.1:3106
```

Provider EIP-1193 chỉ thay ví tương tác. Mọi giao dịch thành công thực thi thật
trên Anvil. Ảnh thêm nhãn môi trường bằng CSS sau hydration, không sửa cây React.
Nếu một lượt browser dừng giữa chừng, giữ evidence cũ và tạo run mới; không
sửa journal, nạp bù hoặc rollback để làm kết quả cũ trông đạt.

Dừng Next rồi dừng fixture/Anvil:

```powershell
$config = Get-Content backend/data/u05-new-run/browser/public-config.json -Raw | ConvertFrom-Json
Invoke-WebRequest -Method Post -Uri ($config.api + '/__u05-fixture/stop')
```

## Phần cần người làm

Operator cung cấp RPC HTTPS 20261, manifest L06 thật và tự seed B03/B05 bằng
issuer. Beneficiary tự xác nhận trong Core; reviewer đối chiếu hash/GrantSpent
thật trên hai thiết bị HTTPS. Lượt này không chạy seed apply hoặc giao dịch L1.
PR #19 cần được push, CI và review lại khi được giao; chưa tự chuyển ready hoặc
đánh dấu task Xong. [Bàn giao tổng hợp](../u04-u05-handoff.md) ghi điểm nối.
