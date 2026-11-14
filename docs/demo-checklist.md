# Q02 · Checklist chạy demo IntraCampus L1

Phạm vi nghiệm thu là QR, ưu đãi SBT, receipt thanh toán trên Student/POS và học
bổng FOOD. B06/U06 đã dừng theo ghi chú trên sprint và tài liệu dự án. Demo
animation trên ChatGPT Sites dùng để giới thiệu. Kiểm thử nghiệp vụ thư viện
thuộc N-75E965E5. Xem [kịch bản P01](demo-flow.md) và [ghi chú Q02](mentor-notes.md).

## Phiếu chuẩn bị cho buổi chạy Core/L1

Điền phiếu trên máy nhóm. Chỉ đưa giá trị công khai vào Git. L02/L06 đã merge
mã và hướng dẫn, còn phiên Q02 ngày 14/11/2026 chưa có bộ cấu hình của bản chạy
thật. Kết quả Anvil ở cuối tài liệu có thể tái hiện độc lập.

| Trước khi bắt đầu | Ghi nhận tại buổi chạy | Xác nhận |
| --- | --- | --- |
| Phiên chạy, giờ UTC+7, commit frontend/backend | … | Hai màn hình trỏ cùng phiên deploy |
| `APP_URL` HTTPS, URL backend từ máy operator | … | Laptop mở `/pos`; điện thoại mở `/student` trong Core |
| RPC HTTPS chính/dự phòng và chain | … | `pnpm rpc:check` trả `ready`, chain 20261; kiểm tra đọc receipt trên Wi-Fi và 4G/5G |
| Manifest L06, deployment hash, SBT, registry, vault | … | Hai `/api/deployment` trả 200 và cùng manifest đã xác minh; gọi URL backend nội bộ từ máy operator nếu cần |
| Phiên bản Core, OS, trình duyệt, camera, mạng hai thiết bị | … | Camera/clipboard hoạt động, quyền ví đúng, thử chuyển hotspot |
| Người vận hành POS, người giữ ví, người ghi kết quả | … | Chỉ người giữ ví demo xác nhận trong Core |
| Ví thường, ví SBT còn hạn, beneficiary, bãi xe, căn-tin | … | Đúng địa chỉ vai trò, số dư tiền/gas, tier và FOOD/allowlist |
| Grant trước khi chạy | … | Ghi giá trị thực tế. Dùng beneficiary đã seed 5.000 nếu cần chứng minh 5.000 → 4.000 |
| Thư mục bản ghi trước | … | File MP4, ảnh receipt và ghi chú deploy mở được khi tắt mạng |

Hướng dẫn cấu hình là [L02](../infra/rpc.md), [L06](deployment.md),
[B03](demo-accounts.md), [B04](b04-integration.md), [B05](b05-grants.md),
[U04](u04-payment.md) và [U05](u05-grants.md). Operator chuẩn bị manifest và
seed theo runbook với tài khoản demo. Ghi số dư thật nếu ví đã chi. Tạo invoice
mới mỗi lượt và tra cứu giao dịch còn chờ trước khi tiếp tục. Giữ khóa, token RPC,
seed phrase và thông tin sinh viên thật ngoài tài liệu, clipboard và bản ghi.

## Thao tác trên hai thiết bị

| Ca | Thao tác | Quan sát để đánh PASS |
| --- | --- | --- |
| QR-01 · Ví thường | POS tạo invoice bãi xe mới. Điện thoại quét QR và kiểm tra giá trước khi mở Core. Người giữ ví xác nhận. | Ví thường trả 3.000 CAMPUS theo cấu hình demo; gas riêng. |
| QR-02 · SBT và đường dán | Tạo invoice mới cho ví SBT còn hạn. Chuyển nguyên văn payload giữa hai thiết bị qua kênh do nhóm chọn, dán ở Student và kiểm tra. | Giá gốc 3.000, giảm 300, trả 2.700 CAMPUS. Payload đúng invoice. Ghi riêng kết quả quét camera và dán. |
| QR-03 · Receipt | Theo dõi cùng invoice trên POS và Student sau khi gửi. Chụp mốc đang chờ nếu quan sát được. | Có hash chỉ là đã gửi/chờ. Sau receipt thành công, hai màn hình khớp invoiceId, hash, payer, merchant, số tiền và verifier; đối chiếu `InvoicePaid`. |
| QR-04 · Hết hạn / sai chain / từ chối | Dùng invoice chưa gửi đã hết hạn theo chain, ví ở chain khác, hoặc bấm từ chối trong Core. Dùng lượt riêng cho mỗi lỗi. | Hóa đơn hết hạn và sai chain chặn ký. Từ chối giữ invoice chưa trả. Chỉ chủ động thử lại sau khi kiểm tra đúng chain và hạn. |
| QR-05 · Mất kết nối trước khi ký | Gián đoạn đường RPC trên thiết bị/fixture được phép. Kiểm tra ở Student rồi nối lại. | Không mở yêu cầu gửi khi chưa xác minh; có thể đọc lại khi kết nối phục hồi. |
| QR-06 · Pending và reload | Với một giao dịch đã gửi, giữ invoiceId/hash, tải lại và diễn tập gián đoạn trên thiết bị/fixture test. Nối lại rồi tra giao dịch cũ. | POS chưa báo đã thu khi chưa xác minh. Student giữ dấu lần gửi. Receipt/event khớp mới xác nhận; số broadcast không tăng khi reload/tra cứu. |
| FOOD-01 · Chi | Đúng beneficiary và căn-tin. Ghi số dư vault và merchant trước khi chi. Ký 1.000 CAMPUS trong Core. | `value = 0`, ví trả gas riêng. Receipt có `GrantSpent` đúng beneficiary/category/merchant/amount; merchant nhận 1.000 và vault đọc lại 5.000 → 4.000 với grant demo mới. |
| FOOD-02 · Đọc và chặn | Đọc ví không có allocation, thử RPC lỗi và allowlist bị chặn trên fixture phù hợp. | 0 đã xác minh khác chưa xác minh. Khi lỗi/merchant bị chặn, giao diện khóa chi; giữ số dư, không sinh thêm khoản chi. |
| FOOD-03 · Khôi phục | Reload pending và thử mất phản hồi sau ranh giới gửi trên fixture. So intent, tài khoản, vault và hash. | Không tự gửi lại. `unknown` còn khóa khi chưa rõ. Nhập hash đúng từ Core để đối chiếu; receipt cũ/sai không giải phóng intent. |

Không ngắt RPC chung để trình diễn lỗi. Nếu giao dịch xác nhận quá nhanh để
chụp mốc pending, ghi rõ trong phiếu rồi xem ca Anvil có tạm dừng tạo block.
Hash/receipt đã xác minh có thể dùng chung với Q01 nếu ở cùng deployment và
có mốc quan sát thật. PR [Q01 #20](https://github.com/pmai4118-ux/intracampus-l1/pull/20)
chỉ có số đo Anvil trong lượt đã review; số Q01 không thay kết quả run này.

## Khôi phục và chuyển phương án dự phòng

1. **Camera:** thử thêm một lần, tối đa 10 giây từ khi không đọc được. POS sao
   chép payload của đúng invoice, điện thoại dán nguyên văn rồi kiểm tra lại
   như khi quét. Trước buổi chạy thử kênh chuyển payload và hotspot trên hai
   thiết bị. Với QR hết hạn: tạo invoice mới sau khi xác định chưa có lần gửi.
2. **Lỗi trước gửi:** dừng ký, chuyển hotspot nếu cần, đọc lại đúng chain và giá.
   Nếu RPC chưa phục hồi sau 20 giây, người vận hành POS báo chuyển dự phòng,
   người ghi kết quả mở file local. Hai mốc này là ngân sách thao tác P01.
3. **Lỗi sau gửi:** ghi invoiceId, tài khoản, chain, contract và hash nếu có.
   Giữ tab và dữ liệu trình duyệt. Khi mạng về, dùng **Tra cứu kết quả cũ** ở
   Student và **Mở lại / đối chiếu hóa đơn** ở POS với cùng invoiceId/hash.
   Receipt null hoặc RPC không tìm thấy hash vẫn là chưa rõ. Giao dịch revert
   đã xác minh có thể tốn gas; U04 yêu cầu invoice mới sau khi đối chiếu.
4. **FOOD:** theo [khôi phục U05](u05-grants.md#gián-đoạn-nhiều-tab-và-lưu-trữ).
   Chỉ khôi phục `prepared` chưa gửi bằng thao tác dành riêng của app sau khi
   tab cũ đã nhả khóa. Với `unknown`, tìm hash trong lịch sử ví và dùng **Đối
   chiếu hash đã gửi**. Giữ lock khi chưa có bằng chứng phù hợp, kể cả khi
   thấy số dư đã đổi. Không xóa journal để tiếp tục chi.
5. **Offline:** mở bản ghi MP4 và ảnh đã tải về. Nói “Bản ghi trước” và đọc
   đúng môi trường. Nếu clip chưa mở được, dùng ảnh và receipt đã lưu. Không
   dùng bản ghi để xác nhận giao dịch đang chờ. Sau buổi demo, đối chiếu giao
   dịch cũ trên đúng mạng rồi ghi kết quả tiếp nối.

## Lượt kiểm chứng local ngày 14/11/2026

Người chạy Codex. App `14b4a62`, Windows, Edge headless, HTTP loopback. Hai
trình duyệt là viewport desktop/mobile trên một máy. Anvil 20261 dùng provider
EIP-1193 mô phỏng Core. Bản sao Next có cùng địa chỉ/ABI local của fixture với
định dạng manifest đã cấu hình để UI chạy được; canonical Git vẫn unconfigured.
Tách riêng các ca gián đoạn bằng route trình duyệt và ca có receipt EVM thật.

| Phần | Lệnh và bằng chứng | Kết quả |
| --- | --- | --- |
| Controller/API | [Log mới](evidence/q02-controller.json) | 8 ca Anvil, gồm hai mức giá, từ chối, mất phản hồi, grant và 3 preflight lỗi |
| QR/SBT/POS | [Báo cáo browser](evidence/q02-payment/browser-report.json) | 8 ca gồm payload QR và clipboard, hai receipt, sai chain, hết hạn, từ chối, RPC trước gửi và khôi phục sau gửi. Quét camera vật lý chưa chạy. |
| FOOD | [Báo cáo browser](evidence/q02-food/browser-report.json), [thông tin lượt chạy](evidence/q02-food/run.json), [receipt RPC](evidence/q02-food/grant-spent-rpc-receipt.json) | 10 ca gồm 5.000 → 4.000, 0/chưa xác minh, allowlist, pending, hai tab và unknown. Ca mất RPC dùng HTTP 503 tiêm trong trình duyệt. |
| CI/mock | Bộ test hiện có theo AGENTS.md | Xem tổng kết kiểm tra tại [ghi chú Q02](mentor-notes.md) |
| Offline | [Bộ dự phòng](evidence/q02-offline/README.md), [log mở file](evidence/q02-offline/offline-verification.json) | MP4, 2 ảnh và ghi chú mở từ file local trong Edge chế độ offline. Cần diễn tập tắt mạng trên laptop dùng trình diễn. |
| Core/Avalanche L1 | `pnpm rpc:check` trả `not-configured` | CHƯA CHẠY các ca QR-01–06 / FOOD-01–03 trên L1; chờ phiếu chuẩn bị |
| Nghiệm thu độc lập | Bảng kết quả bên dưới | CHƯA CHẠY, cần một thành viên khác tự thực hiện |

Tái hiện fixture theo [runbook Anvil/Next](evidence/u05-b05-integration.md#tái-hiện-browser).
Từ gốc repo, mở terminal A, đặt `ANVIL_BIN` nếu Anvil chưa ở PATH, build hợp
đồng, rồi chọn thư mục mới. Nếu chưa có thư mục `backend/data`, hãy tạo trước.

```powershell
pnpm install --frozen-lockfile
forge build --root contracts --force
$env:U05_BROWSER_FIXTURE_DIR = Join-Path (Get-Location) 'backend/data/q02-new/browser'
node frontend/test/u04-u05-local-evidence.mjs backend/data/q02-new/controller.json
```

Khi terminal A báo fixture ready, từ gốc repo chạy ở terminal B:

```powershell
node frontend/test/prepare-u05-browser.mjs backend/data/q02-new/browser
Set-Location backend/data/q02-new/browser/source
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm --filter @intracampus/frontend build
pnpm --filter @intracampus/frontend start --port 3117
```

Terminal C từ gốc repo với Python Playwright và Edge đã cài. Không chạy hai
script đồng thời vì cùng dùng automine của fixture. Chọn đường dẫn đầu ra mới.

```powershell
python frontend/test/u05-b05-browser.py backend/data/q02-new/browser backend/data/q02-new/food --origin http://127.0.0.1:3117
python frontend/test/q02-payment-browser.py backend/data/q02-new/browser backend/data/q02-new/payment --record-dir backend/data/q02-new/recordings
```

Sau khi xem kết quả, dừng Next bằng Ctrl+C. Dừng fixture bằng lệnh trong
[runbook](evidence/u05-b05-integration.md#tái-hiện-browser), thay đúng đường dẫn
`backend/data/q02-new/browser/public-config.json`. Mỗi lượt khởi tạo Anvil mới
có hash/receipt riêng. Dùng JSON đã lưu để xem lại lượt cũ khi node đã dừng.

## Phiếu lượt nghiệm thu độc lập

Người chạy … · Người giữ ví … · Người ghi … · Giờ UTC+7 … · commit/deploy … ·
Core/thiết bị/mạng … · APP_URL … · chain/deployment hash …

| Ca | Giờ | Mong đợi | Quan sát thực tế | PASS / FAIL / CHƯA CHẠY | InvoiceId/hash/ảnh/clip | Lỗi đã xử lý |
| --- | --- | --- | --- | --- | --- | --- |
| … | … | … | … | CHƯA CHẠY | … | … |

Ghi riêng thời điểm thử camera/dán, hotspot, mở MP4 khi tắt mạng, kết quả tra
giao dịch cũ và ai quyết định chuyển phương án. Người nghiệm thu chỉ ký sau
khi chạy thực tế. Đính kèm receipt và bằng chứng hai thiết bị của chính lượt đó.
