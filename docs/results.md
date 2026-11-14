# Q01 · Phí, receipt và độ trễ POS

Đã chạy luồng U04 từ trang POS tạo invoice mới đến Student dán payload, kiểm tra
quote, gửi qua provider EIP-1193 và POS hiển thị biên nhận khớp hash. Giao dịch và
receipt trong hai lượt dưới đây đến từ Anvil chain 20261. Kết quả dùng để kiểm
chứng công cụ đo. Môi trường L1 của nhóm đang chờ cấu hình và người giữ ví Core.

## Điều kiện và kết quả local

- App `f48624b84124af8bb69023c1e7198c0477f09549`, Node 24.22.1, pnpm 11.25.0,
  Foundry/Anvil 1.7.1. Manifest của lần chạy nằm trong mỗi log. Verifier
  `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` được kiểm tra qua receipt deploy,
  hash block canonical và hash bytecode. Cùng một backend fixture phát hành
  invoice, đối chiếu receipt và trả trạng thái cho Student/POS. Frontend local
  dùng bản sao manifest cùng địa chỉ và ABI theo harness U05; source chính vẫn
  dùng manifest canonical `unconfigured`.
- Một máy Windows, HTTP loopback, Edge headless với POS 1440×1000 và Student
  390×844. Anvil automine. Ví giả lập gửi bằng tài khoản local đã mở khóa. Lượt
  lặp tạo block mới trước mỗi invoice để cập nhật thời gian chain mà B01 dùng
  cho TTL. Poll POS theo app 2.000 ms, poll receipt từ runner 50 ms, quan sát DOM
  POS mỗi 20 ms cộng thời gian gọi RPC và trình duyệt.
- Một đồng hồ monotonic ở runner cho mọi mốc. `request` là lúc adapter nhận
  yêu cầu ví, `submit` là ngay trước khi adapter chuyển lệnh tới RPC, `hash`
  là khi nhận kết quả. `receipt` là khi poll thấy receipt; `pos` là khi thấy
  biên nhận đúng hash đã hiển thị. Các mốc adapter gồm chi phí chuyển sự kiện
  qua trình duyệt. `0 ms` nghĩa là hai mốc rơi vào cùng tick đồng hồ.

Số liệu dưới đây lấy từ [log lượt lặp](evidence/q01/anvil-repeat.json). Mỗi
ô độ trễ là p50 / p95 (ms) với n = 3 mỗi đoạn, theo nearest rank
`sorted[ceil(p × n) − 1]`. Với n = 3, p95 chính là giá trị lớn nhất đã thấy.

| Ví | Lượt thử / xác minh / lỗi | Tiền trả (CAMPUS) | Phí (CAMPUS), min–max | Submit → receipt (ms) | Hash → receipt (ms) | Receipt → POS (ms) | Hash → POS (ms) |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| Thường | 4 / 3 / 1 từ chối ký | 3.000 | 0.000079932627257616–0.000081906182982594 | 31 / 31 | 15 / 31 | 1813 / 1844 | 1828 / 1875 |
| SBT tier 1 còn hạn | 3 / 3 / 0 | 2.700 | 0.000080134098617529–0.000081056753643021 | 16 / 47 | 16 / 32 | 1890 / 1891 | 1891 / 1906 |

Phí là `gasUsed × effectiveGasPrice` từ receipt, tính `bigint` và đổi đơn vị
CAMPUS ở 18 decimals. Giá gốc và giảm giá được xác minh từ event riêng. Hai
nhóm chạy tuần tự qua các block với giá gas khác nhau, nên các dải phí không
được dùng để kết luận SBT rẻ hơn hay đắt hơn. Thời gian thao tác của người giữ
Core và thời điểm API trả paid độc lập chưa được đo. JSON đầu ra còn có phân
vị `request → hash` và `request → submit` để đọc chi phí adapter riêng.

[Log lượt đầu](evidence/q01/anvil-run.json) giữ cả 7 lượt thử: 5 xác minh, 1 từ
chối và 1 revert. Receipt revert tại block 14. Timestamp block `1794587809`
vượt `expiresAt` `1794587696`, vì Anvil đứng ở head cũ trước khi B01 tạo invoice.
Phí revert `0.000058575637880144 CAMPUS` được giữ, không tính vào độ trễ thành
công. Cả hai log lưu envelope, receipt JSON-RPC, hash block canonical và
tx hash cho từng lượt đã gửi. Anvil chạy tạm, nên sau khi dừng node hãy đối
chiếu receipt ngay trong log; tái chạy tạo deployment/hash mới.

## Tái kiểm

Từ gốc repo, dùng Node 24. `summarize` đọc lại log mà không cần mạng hay `.env`.

```powershell
pnpm install --frozen-lockfile
pnpm test:q01
node scripts/measure-payment.ts summarize docs/evidence/q01/anvil-run.json
node scripts/measure-payment.ts summarize docs/evidence/q01/anvil-repeat.json
```

Để chạy lại EVM/browser, dựng fixture và bản sao Next theo
[hướng dẫn browser tích hợp](evidence/u05-b05-integration.md#tái-hiện-browser).
Dùng một run mới dưới `backend/data`, build contract với `forge build --force`,
chạy `u04-u05-local-evidence.mjs` với `U05_BROWSER_FIXTURE_DIR`, rồi chạy
`prepare-u05-browser.mjs` và khởi động Next trên cổng 3116. Python cần Playwright
và Microsoft Edge. Khi fixture và web còn chạy, từ gốc repo:

```powershell
$run = 'backend/data/q01-new-run'
$cfg = Get-Content "$run/browser/public-config.json" -Raw | ConvertFrom-Json -AsHashtable
$cfg.manifest | ConvertTo-Json -Depth 100 | Set-Content "$run/manifest.json" -Encoding utf8
$env:INTRACAMPUS_RPC_URL = $cfg.rpcUrl
node scripts/measure-payment.ts check "$run/manifest.json"
python scripts/test/measure-payment-browser.py "$run/browser" "$run/observations.json" --port 3116
node scripts/measure-payment.ts collect "$run/manifest.json" "$run/observations.json" "$run/raw.json"
node scripts/measure-payment.ts summarize "$run/raw.json"
```

`collect` xác minh chain, deployment và đọc receipt qua RPC. Nó giữ mốc do
người đo ghi, dùng file đầu ra mới và không thay đổi trạng thái chain. Với hash
cũ, đặt `observed: "historical"`, `marksMs: {}` và cung cấp envelope gốc lấy từ
GET invoice. Chỉ báo phí/receipt nếu đối chiếu được. Receipt đến sau timeout
có thể chứng minh phí đã trả; mẫu vẫn được tính là timeout trong buổi đo.

## Buổi đo với Core trên L1

1. Operator cung cấp URL HTTPS của web, địa chỉ API, RPC 20261, manifest L06 đang chạy và
   hai ví demo đủ tiền/gas, một ví có SBT còn hạn. Đặt RPC trong cấu hình riêng
   của máy đo rồi chạy `pnpm rpc:check`. Đặt `INTRACAMPUS_RPC_URL`, `Q01_APP_URL`,
   `Q01_API_URL` trong shell và chạy `node scripts/measure-payment.ts check
   <manifest.json>`. Công cụ đọc `/api/deployment` của frontend/backend và so
   toàn bộ manifest. Nếu backend không công khai, operator có thể chạy trên
   máy backend và dùng URL loopback cho API. Kiểm tra giá/ưu đãi trước buổi đo.
2. Chốt số mẫu và ngân sách với operator. Dùng cùng bản deploy, thiết bị và
   đường mạng cho mỗi nhóm. Mỗi lần tạo invoice mới. Người giữ ví tự xác nhận
   trong Core. Dùng đồng hồ quan sát chung, ví dụ quay liên tục cả hai màn hình
   với đồng hồ/bộ đếm hiện trong khung và ghi sự kiện từ bản ghi theo cùng
   timecode. Để trống mốc không đọc được, ghi độ phân giải và sai số thao tác.
   Nếu chỉ thấy hash trên Student, ghi đó là lúc **quan sát hash trên UI**.
   Người đo poll receipt qua RPC và đánh dấu quan sát đầu tiên trên cùng đồng
   hồ, hoặc bỏ trống đoạn đó. Mốc POS phải thấy biên nhận đúng hash trên màn
   hình; nếu chỉ thấy API paid thì dùng `apiPaid`.
3. Tạo `observations.json` theo phần `context` và `attempts` trong log mẫu, bỏ
   `manifest`, `rpcReceipt`, `canonicalBlockHash` và đặt `source: "avalanche-l1"`.
   `context` chứa commit, thời điểm bắt đầu, thiết bị, ví, đường mạng, đồng hồ,
   polling (ms hoặc `null` khi không quan sát) và số mẫu dự kiến từng nhóm.
   Mỗi lượt có `invoiceId`, `payer`, `tier`, `envelope` từ API, `observed`,
   `txHash` nếu có và `marksMs` tính từ đầu buổi. `request`, `submit`, `hash`,
   `receipt`, `apiPaid`, `pos` đều tùy khả năng quan sát. Chọn `hash-observed`
   khi đã thu mốc như kế hoạch, hoặc `rejected`, `pending`, `timeout`,
   `rpc-error`, `unknown` theo kết quả thực tế. Giữ nguyên hash khi chờ, không
   gửi lại để bù mẫu. Chạy `collect` với manifest thật và đường dẫn log mới.
4. Đọc summary, mở lại từng hash/receipt trên cùng RPC và đối chiếu màn hình
   POS. Ghi điều kiện đo, n theo từng đoạn và lỗi. Chỉ chia sẻ địa chỉ/receipt
   của ví demo, không lưu URL có token, dữ liệu sinh viên hoặc khóa.

| Số liệu cho Q05 | Avalanche L1 của nhóm |
| --- | --- |
| Deployment, hash, số mẫu, phí CAMPUS | Chờ operator cung cấp môi trường và chạy đo |
| p50/p95 hash → receipt và receipt → POS | Chưa có quan sát trên bản demo L1 |

`pnpm rpc:check` trên máy thực hiện trả `not-configured`, chain mong đợi 20261.
Manifest Git chưa có địa chỉ L1. Số liệu Anvil ở trên dùng cho QA và tái hiện
công cụ; bảng Q05 chờ số liệu mạng demo cùng điều kiện đo. Phân vị của buổi
đo nhỏ mô tả mẫu quan sát, không dùng để suy ra thông lượng mạng.
