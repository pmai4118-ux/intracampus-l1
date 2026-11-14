# P01 · Phạm vi MVP và cách làm việc của nhóm 3 người

Ngày soạn: 08/11/2026. Trạng thái: baseline lịch sử; phạm vi library hiện hành được chốt tại D019 và giao kèo Library. Tài liệu này không xác nhận nghiệm thu các task trên sprint.

Tài liệu đi cùng: [kịch bản demo hai thiết bị](demo-flow.md). Yêu cầu và mã task tham chiếu từ [bảng sprint IntraCampus L1](https://intracampus-l1-sprint.mphung2532.chatgpt.site/). Quy trình làm việc theo [AGENTS.md](../AGENTS.md).

## 1. Mục tiêu và trạng thái hiện tại

Chứng minh thanh toán bãi xe trên IntraCampus L1 bằng QR, ví và receipt khớp on-chain; sau đó trình diễn grant giới hạn merchant và luồng mượn sách có cọc CAMPUS qua sinh viên, escrow và thủ thư. Phạm vi/library acceptance chi tiết nằm trong [giao kèo Library](library-contract.md).

Repo tại thời điểm soạn mới có khung trang web, API health/network và test Foundry cơ bản. Các màn hình, hợp đồng và hành vi mô tả dưới đây là mục tiêu triển khai, chưa phải tính năng đã chạy hay kết quả kiểm thử.

Thông số đã có trong [cấu hình mạng dùng chung](../packages/network/src/index.ts): chain ID `20261`, native token `CAMPUS`, `18` decimals. CAMPUS dùng cho thanh toán và gas; học bổng nằm trong vault riêng. Quyền ưu đãi do SBT quyết định.

## 2. Hai persona và thiết bị

| Persona | Thiết bị / màn hình | Đầu vào | Kết quả cần thấy |
| --- | --- | --- | --- |
| Nhân viên bãi xe demo | A: laptop, `/pos` | Merchant và dịch vụ từ menu demo | QR, số tiền, hạn hóa đơn; sau thanh toán có biên nhận |
| Sinh viên có thẻ ưu đãi demo | B: điện thoại, `/student` và ví hỗ trợ EVM | QR hoặc nội dung QR được dán; xác nhận bằng ví | Đúng mạng, thẻ/tier, giá gốc, giảm giá, số phải trả, trạng thái và tx hash |

Sinh viên thao tác grant và thư viện trên thiết bị B; thủ thư duyệt và quyết toán từ màn staff trên thiết bị A. Catalog được seed trước; không cần màn hình quản trị catalog.

## 3. Phạm vi P0, P1 và mở rộng

P0/P1 dưới đây là thứ tự triển khai và trình diễn trong kế hoạch P01, không sửa priority hoặc trạng thái trên bảng sprint. Cả P0 và P1 đều thuộc MVP của bảng hiện tại. Thay đổi cam kết MVP cần được cả nhóm ghi nhận; không tự bỏ P1 khi thiếu thời gian. Chỉ các task `X` là mở rộng sau MVP.

| Mức | Phạm vi / task | Điều kiện hoàn thành quan sát được |
| --- | --- | --- |
| P0 | Phạm vi và giao kèo: `P01`, `P02` | Nhóm review hai tài liệu P01; payload, chữ ký, receipt và mã lỗi P02 có fixture đối chiếu TypeScript–Solidity |
| P0 | L1 và truy cập hai thiết bị: `L01`, `L02` | RPC trả đúng `20261`; laptop và điện thoại truy cập được mạng demo |
| P0 | SBT và thanh toán: `L03`, `L04` | Thẻ không chuyển nhượng, tier/hạn được kiểm tra; invoice đúng được trả một lần, giá cuối do contract quyết định |
| P0 | Invoice và receipt: `B01`, `B02`, `B03`, `B04` | Có dữ liệu ví demo, QR ký đúng, POS chỉ báo thành công khi receipt/event đã xác minh |
| P0 | Giao diện luồng chính: `U01`, `U02`, `U03`, `U04` | Hoàn thành luồng POS → điện thoại → ví → biên nhận, có trạng thái chờ và lỗi |
| P1 | Học bổng giới hạn merchant: `L05`, `B05`, `U05` | Chi căn-tin thành công; chi ví cá nhân/merchant ngoài allowlist bị chặn; số dư khớp chain |
| P1 | Module thư viện: `N-81226E74`, `N-5DFBAD4D`, `N-47121905`, `N-696719F4`, `N-75E965E5` | Cọc chỉ giữ bản sau receipt; thủ thư duyệt, nhận trả hoặc tất toán; frontend/backend nối trên API thật |
| P0 + P1 | Bản triển khai dùng chung: `L06` | Chốt địa chỉ, ABI và cấu hình theo đúng dependency trên sprint; `L06` phụ thuộc cả `L04` và `L05` |
| P0 + P1 | Nghiệm thu, đo và nộp bài: `Q01`–`Q06` | Kết quả đo có tx hash, checklist hai thiết bị, hướng dẫn dựng lại, video 3 phút/offline, pitch và hồ sơ nộp |
| Mở rộng | `X01`–`X05` | ICM/ICTT, indexer/WebSocket, admin/thẻ 3D và chuẩn bị chung kết; chỉ làm sau mốc MVP |

Có thể kiểm tra luồng P0 trên EVM local trước khi ghép bản L1. Việc ghép `B04` lên bản triển khai chung vẫn chờ `L06`; không đổi thứ tự phụ thuộc để coi một test local là đã hoàn thành tích hợp L1.

## 4. Bộ dữ liệu demo đề xuất

Các giá trị nghiệp vụ sau là đề xuất cụ thể để dựng fixture và review; chưa được xác nhận bởi cấu hình contract. P02 và người nhận task contract phải chốt cùng một bộ trước khi tích hợp.

| Dữ liệu | Giá trị / quy tắc đề xuất | Nơi chốt tiếp |
| --- | --- | --- |
| Dịch vụ | “Một lượt gửi xe demo”, merchant “Bãi xe demo” | `P02`, `B01` |
| Giá gốc | `3.000 CAMPUS` = `3000000000000000000000` đơn vị nhỏ nhất | `P02` |
| Tier ưu đãi | Ví có SBT còn hạn: giảm `10%`; trả `2.700 CAMPUS`, chưa gồm gas | `L03`, `L04`, `P02` |
| Ví đối chứng | Ví thường hoặc thẻ hết hạn: giảm `0%`, trả `3.000 CAMPUS`, chưa gồm gas | `L03`, `L04`, `B03` |
| Hạn invoice | `300` giây tính từ lúc tạo; `expiresAt` biểu diễn bằng Unix giây | `P02`, `B01`, `L04` |
| Học bổng | Số dư ban đầu `5.000 CAMPUS`; một lần chi căn-tin `1.000`, còn `4.000`; gas trả bằng CAMPUS trong ví cá nhân | `L05`, `B05`, `U05` |
| Ví và merchant | Dùng địa chỉ demo tách biệt cho sinh viên ưu đãi, sinh viên thường, bãi xe, căn-tin và ví ngoài allowlist | `B03`, `B05` |
| Hạ tầng | RPC HTTPS dùng chung, địa chỉ contract, ABI và ví đã nạp CAMPUS đủ thanh toán/gas | `L01`, `L02`, `L06`, `B03` |

Trong code dùng số nguyên đơn vị nhỏ nhất; TypeScript dùng `bigint`, JSON dùng chuỗi số nguyên. Không dùng số thập phân để tính tiền. Địa chỉ thật của bản demo, quy tắc làm tròn ưu đãi và schema chi tiết được chốt ở task tương ứng, không suy ra từ bảng ví dụ này.

## 5. Phân công luân phiên và trách nhiệm bàn giao

Nhóm gồm BaoBao, hwng và duylhm. Theo cách làm việc nhóm đã trao đổi, cả ba có thể luân phiên nhận task ở L1/contract, backend và frontend; không cố định một người vào một module. Tài liệu này không nhận task hoặc chỉ định reviewer trên bảng thay cho thành viên.

Mỗi task có một người thực hiện chịu trách nhiệm đầu ra và một người khác review. Người thứ ba có thể chạy lại kịch bản tích hợp hoặc nhận task độc lập. Ghi tên người làm/reviewer trên sprint trước khi bắt đầu; khi đổi người, bàn giao branch/PR, trạng thái kiểm tra và phần còn thiếu. Sau mỗi PR, các vai trò có thể đổi cho lượt tiếp theo. Không có người tự duyệt PR của mình.

| Trách nhiệm | Người chịu trách nhiệm theo lượt | Đầu ra bàn giao |
| --- | --- | --- |
| P01 và giao kèo `P02` | Người nhận từng task; người nhận contract/backend cùng đối chiếu | Tài liệu, fixture, danh sách quyết định cần review |
| L1 / Solidity `L01`–`L06` | Người nhận task L tương ứng | Chain/RPC, cấu hình, contract, ABI, test và địa chỉ bản deploy |
| Backend `B01`–`B05` | Người nhận task B tương ứng | Module theo [kiến trúc backend](../backend/README.md), API, dữ liệu seed và bằng chứng receipt |
| Frontend `U01`–`U05` | Người nhận task U tương ứng | Màn hình hai thiết bị, trạng thái/lỗi, bằng chứng tích hợp |
| Nghiệm thu `Q01`–`Q06` | Người nhận task Q; một thành viên khác chạy lại | Log/tx hash, checklist, video/offline, tài liệu và hồ sơ |

Gợi ý mở ba luồng sau khi nhóm duyệt P01: một người nhận `P02`, một người nhận `U01`, người còn lại nhận `L01`. Thành viên tự chọn luồng trên sprint; chỉ bắt đầu task tiếp khi dependency của nó đã đáp ứng. Luân phiên là đổi trách nhiệm giữa các lượt, không đồng thời sửa cùng một phần chưa bàn giao.

Các mốc phối hợp: nhóm duyệt P01 → chốt P02 giữa contract/backend/UI → hoàn thiện và seed SBT → chạy luồng thanh toán local → triển khai bộ contract theo L06 → ghép luồng hai thiết bị → hoàn thành học bổng và Library → nghiệm thu và nộp bài. Việc phát triển có thể song song theo dependency; không đợi đến demo mới đối chiếu ABI hoặc payload.

## 6. Ranh giới dữ liệu và nguồn sự thật

| Thành phần | Chịu trách nhiệm | Bàn giao |
| --- | --- | --- |
| POS / backend | Chọn dịch vụ trong danh sách, tự xác định giá gốc, tạo invoice và chữ ký merchant | QR/payload có thể kiểm tra theo P02; khóa ký chỉ ở backend |
| Student / ví | Đọc invoice, kiểm tra mạng, hiển thị merchant và số tiền; người dùng xác nhận | Giao dịch lên contract trên `20261`, tx hash khi đã gửi |
| Contract | Kiểm tra signer/domain/hạn, merchant/category, invoice chưa dùng; tính giá cuối theo SBT | Giao dịch thành công phát `InvoicePaid`; ABI/field cụ thể thuộc P02/L04 |
| Backend receipt | Xác minh chain, địa chỉ contract, receipt thành công và event khớp invoice/merchant/số tiền | Trạng thái và biên nhận cho POS; không coi tx hash đơn lẻ là thành công |
| Grant vault / Library escrow | Vault và escrow thực thi quyền chi/cọc; backend xác minh receipt và chiếu trạng thái | Receipt/số dư grant, request/loan và tồn kho cùng khớp nguồn on-chain/SQLite |

Tên endpoint, kiểu EIP-712 và ABI cuối cùng thuộc P02/L04/L05. P01 chỉ chốt luồng và trách nhiệm, không thay cho giao kèo kỹ thuật đó.

## 7. Phần thật, giả lập và phương án dự phòng

Tên nhân vật, dịch vụ, địa chỉ ví demo và giá trị seed là dữ liệu giả lập. Trong buổi demo trực tiếp, L1, SBT, chữ ký invoice, giao dịch, event và receipt phải là dữ liệu thật của mạng demo. Không dùng hồ sơ sinh viên thật. CAMPUS demo không đại diện tiền thật.

Khi camera lỗi, dùng đường dán cùng nội dung QR đã ký; giữ nguyên dữ liệu được kiểm tra. Khi RPC lỗi, dừng gửi mới, giữ trạng thái đã biết và đối chiếu tx hash cũ sau khi nối lại. Một giao dịch chưa xác minh không được đổi thành đã trả hoặc gửi lại tự động. Quy trình và mốc chuyển sang video nằm trong [kịch bản dự phòng](demo-flow.md#5-kịch-bản-lỗi-và-dự-phòng).

Video, ảnh và receipt đã ghi trước chỉ dùng để minh họa có nhãn “Bản ghi trước — không phải giao dịch trực tiếp”. Fixture và EVM local được ghi nhãn riêng; không thay thế bằng chứng chạy L1. Bộ offline được chuẩn bị và chạy thử ở Q02/Q04, hiện chưa có trong repo.

## 8. Review và nghiệm thu P01

| Nội dung cần xác nhận | Trạng thái hiện tại | Cách chốt |
| --- | --- | --- |
| Cách làm luân phiên giữa ba thành viên | Người giao việc đã xác nhận; chưa có xác nhận của cả nhóm | Cả nhóm review nguyên tắc mỗi task có người làm và reviewer khác nhau |
| P0/P1 đều trong MVP; các task X để sau | Đề xuất theo bảng sprint | Ba thành viên duyệt phạm vi trong PR |
| Giá, mức giảm, TTL và bộ dữ liệu học bổng | Đề xuất ở mục 4 | Đối chiếu với P02, contract và seed trước tích hợp |
| Tên người nhận từng task / reviewer | Thành viên tự nhận theo lượt; chưa được tài liệu chỉ định | Ghi trên sprint và PR khi nhận việc |
| RPC, địa chỉ deploy và bộ offline | Chưa có trong bản source hiện tại | Bàn giao tại L02/L06 và Q02/Q04 |

Checklist để reviewer P01 đối chiếu:

- [ ] Cả ba thành viên duyệt phạm vi và cách ghi người chịu trách nhiệm cho từng task.
- [ ] Hai persona, hai thiết bị và đường truy cập được mô tả rõ.
- [ ] Mỗi bước demo có đầu vào, màn hình, thao tác và kết quả quan sát được.
- [ ] Có sơ đồ bàn giao QR → ví → contract → POS, phân biệt dữ liệu demo và nguồn on-chain.
- [ ] Có bảng P0/P1/mở rộng và phạm vi Library đã duyệt.
- [ ] Có đường dán QR, phục hồi RPC và mốc chuyển video; không báo thành công giả.
- [ ] Một thành viên khác đọc kịch bản và diễn tập thao tác trên giấy mà không cần tác giả giải thích thêm; các task Q kiểm tra chạy thật sau khi triển khai.

Bằng chứng bàn giao P01: một PR tiêu đề `[P01] Chốt phạm vi MVP và kịch bản demo hai thiết bị`, chứa hai tài liệu này và kết quả kiểm tra tài liệu. Cần CI qua và ít nhất một thành viên khác review theo AGENTS.md; chỉ xác nhận Xong sau khi nhóm duyệt. Bản tài liệu được soạn xong không đồng nghĩa hệ thống đã chạy hoặc cả nhóm đã nghiệm thu.
