# IntraCampus L1: deploy và lỗi Core/RPC

**Cập nhật:** 2026-11-21 (Asia/Ho_Chi_Minh)
**Mục đích:** Ghi lại quyết định triển khai, tình trạng đã quan sát trên app live, các kiểm tra đã làm, giả thuyết và bước tiếp theo. Tách bằng chứng khỏi điều chưa xác minh.

## Tóm tắt nhanh

- App đang chạy trên Vercel Preview: `https://intracampus-l1-jsbs4s4gv-ae-12-t.vercel.app/student`.
- Hạ tầng backend/RPC demo dự kiến chạy trên Google Cloud Compute Engine; VM được nhắc đến là `intracampus-demo-vm`, zone `asia-southeast1-b`. Trạng thái cấu hình dịch vụ trên VM chưa được kiểm tra lại trong lượt này.
- Chain của bản cloud là `20261120`; native currency khai báo trong package dùng chung là `CAMPUS`, 18 decimals. Chain local trong `infra/genesis.json` là `20261`, khác chain cloud.
- Student/Core đang không hiện CAMPUS trong Assets; ở trang live, app cũng không đọc xác minh được balance. Chưa chứng minh RPC nào đang sai, nhưng lỗi RPC/network đang là giả thuyết ưu tiên vì có thể ảnh hưởng cả hai hiện tượng.
- Lượt thanh toán gửi xe gần nhất không có giao dịch trong Core Activity theo người dùng. App đang giữ hóa đơn ở trạng thái chưa rõ kết quả nên không mở nút gửi lại.
- QR gửi xe được quan sát trên live đã hết hạn lúc **2026-11-21 00:26:20 giờ Việt Nam**. Không dùng lại QR đó; cần hóa đơn mới ở POS sau khi kiểm tra RPC.
- Chưa có tx hash, receipt hay bằng chứng thanh toán thành công cho lượt này. Không được báo là đã thanh toán.

## Quyết định và ngữ cảnh deploy

- Người dùng chọn Vercel cho frontend và Google Cloud cho backend/RPC gateway, thay vì coi Cloud Storage là nơi chạy backend.
- Người dùng cho phép deployment Production đầu tiên trên Vercel để có thể dùng Preview về sau; email verification đã được người dùng hoàn tất.
- Google Cloud có khoản credit dùng thử khoảng **300 USD**, hiển thị giá trị **₫7,791,151**, thời hạn đến **2027-01-05**. Đây là credit có hạn, không phải hạn mức chi tiêu cứng.
- Ngân sách mong muốn tối đa **150 USD/tháng**. Estimate VM từng hiện **135.24 USD/tháng**, còn khoảng **14.76 USD** trước ngưỡng mục tiêu. Người dùng chấp nhận ngưỡng mềm và cảnh báo sau khi được giải thích rằng GCP không chặn cứng mọi chi phí Compute Engine và billing có độ trễ.
- Người dùng đã cho phép SSH qua IAP để cấu hình backend trên VM. Không ghi password, private key, token, nội dung `.env` hay thông tin đăng nhập vào tài liệu này.
- Trước đó người dùng nói đã tự làm thủ công một số bước Phase 1 và không muốn Codex làm lại. Khi tiếp tục cần kiểm tra hiện trạng trước, không lặp thao tác.
- Tài khoản Cloud SQL được mở để xem tùy chọn tạo DB, nhưng không có bằng chứng trong lượt này rằng instance Cloud SQL đã được tạo. Không mặc định nó đang tồn tại.

## Ví demo người dùng chọn

Các địa chỉ dưới đây do người dùng cung cấp để gán vai trò. Đây là địa chỉ công khai, không phải khóa bí mật:

| Vai trò | Địa chỉ |
| --- | --- |
| Librarian | `0xdF3E797ac8A969992D6395B62B347043A2aE0F68` |
| Parking | `0x2ac10704067a2a68E8945185F30865dBFBE834f3` |
| Canteen | `0x73f0129Fd4B3f4Cd63290b38412345951d9BE1a0` |
| Quỹ / treasury | `0x83907f9A2685efcbb2BeDa057Cb23a3809c8f750` |
| Student | `0x0A3298bB7C6bCE6094188C2755468DEefCBB4bA3` |

Việc các địa chỉ đã được deploy/config chính xác cần đối chiếu lại với manifest live trước khi dùng làm bằng chứng.

## Các vấn đề người dùng đã báo

### 1. Nộp cọc thư viện

- Screenshot trang Thư viện cho thấy phần `Nộp cọc · Chưa rõ ví đã gửi hay chưa`, có ô nhập hash và nút `Kiểm tra hash` / `Đối chiếu nộp cọc`.
- Người dùng báo không thấy chỗ để nộp cọc, chỉ thấy phần nhập hash.
- Screenshot cho thấy giao diện đang ở trạng thái khôi phục/đối chiếu một lượt trước; chưa xác minh luồng tạo yêu cầu nộp cọc mới có bị thiếu nút ở trạng thái bình thường hay không.
- **Trạng thái:** Chưa xử lý/xác minh xong. Cần tái hiện bằng request nộp cọc mới, không dùng thao tác thử gây giao dịch thật.

### 2. CAMPUS không hiện trong Core Assets

- Core Extension đang bật Testnet mode. Người dùng đã thêm custom network cho IntraCampus L1 và nói đã điền RPC, chain ID, symbol và token name.
- Screenshot network hiển thị Chain ID `20261120`, symbol `CAMPUS`, token name `CAMPUS token`; ô Explorer URL và Logo URL để trống. RPC URL trên ảnh bị cắt nên không đọc được đầy đủ.
- Core Assets hiển thị `No assets yet`; giá tổng ở một số màn hình là `$-`. Người dùng nói `$-` cũng từng xuất hiện ở mạng local, vì vậy thiếu price feed không đủ để giải thích việc asset không hiện.
- Người dùng đã xóa custom network local; sau đó CAMPUS local cũng biến mất khỏi danh sách Core. Điều này phù hợp với danh sách tài sản phụ thuộc network, nhưng không xác định nguyên nhân mạng online.
- Chain ID local trong repo (`20261`) khác chain cloud (`20261120`), nên không ghi giả thuyết “hai network dùng cùng chain ID” như kết luận.
- **Chưa xác minh:** Core custom network đang trỏ tới đúng RPC online chưa; RPC đó trả chain ID/head/balance nào; CAMPUS là native coin hay ERC-20 trên RPC online; Core có indexer/asset discovery cho custom L1 đó không.

### 3. Core không bật hộp thoại ký khi trả phí gửi xe

- Người dùng thử trả hóa đơn parking; bước ký Core bị bỏ qua, và xác nhận không có giao dịch trong Core Activity.
- Đã đọc trạng thái tab Vercel live bằng computer use, không bấm thanh toán hay gửi giao dịch:
  - `Ví thật` đang được chọn, chain app hiển thị `20261120`.
  - Ví đang kết nối: `0x0a3298bb7c6bce6094188c2755468deefcbb4ba3`.
  - Balance hiển thị `Đang đọc dữ liệu` / `Chưa đọc được` / `Chưa có số dư đã xác minh`.
  - Invoice là parking `INV-20261120-PARKING-e38551cb-2a62-426d-a7b7-a9a6ed6fcf5c`, merchant là ví Parking ở trên, amount ban đầu 3 CAMPUS; preview áp dụng giảm 10%, số trả 2.7 CAMPUS.
  - UI nói chưa có receipt đã xác minh và phải tiếp tục tra cứu lần gửi cũ; nút thanh toán mới không hiển thị.
  - `expiresAt=1795195580`, tương ứng **2026-11-21 00:26:20 giờ Việt Nam**.
- Đã đọc code cục bộ:
  - `PayInvoice` tạo `PaymentController` cho invoice và khóa nút nếu ví, session hoặc trạng thái thanh toán chưa sẵn sàng.
  - `PaymentController` lưu payment journal với `txHash: null` trước khi gọi `wallet.sendTransaction`.
  - Wallet gọi `eth_accounts`, `eth_chainId`, sau đó mới gọi `eth_sendTransaction` trên provider Core.
  - Nếu lời gọi provider đã bắt đầu nhưng trả lỗi không phân loại được, trạng thái được giữ là `unknown` và lần tải lại tiếp tục chặn gửi trùng.
- Đây là cơ chế phòng tránh thanh toán trùng, nhưng nó cũng có thể khiến giao diện giữ trạng thái không rõ kết quả dù Core không tạo giao dịch. Không còn trace của lỗi provider trong UI hiện tại để xác định vì sao hộp thoại không mở.
- **Trạng thái:** Chưa có tx hash/receipt; nguyên nhân hộp thoại không xuất hiện chưa được xác định. Hóa đơn hiện tại đã hết hạn, cần POS tạo invoice mới sau khi xác minh RPC.

## Kiểm tra và nguồn bằng chứng

- **Computer use, chỉ đọc:** mở tab student trên Vercel Preview; xác nhận live mode, chain, địa chỉ ví, trạng thái balance và invoice parking. Không click thanh toán, không gọi Core ký, không tạo giao dịch.
- **Computer use, chỉ đọc:** mở `https://intracampus-l1-jsbs4s4gv-ae-12-t.vercel.app/api/network`; nhận `status=ready`, `expectedChainId=20261120`, `chainId=20261120`, `latestBlock.number=49`, `headAgeSeconds=175`. Endpoint này proxy tới backend và chứng minh backend network probe/RPC còn phản hồi lúc kiểm tra; nó không thay thế phép `eth_getBalance` trực tiếp.
- **Vercel Preview env (chỉ xem tên biến):** project tab liệt kê `BACKEND_URL` là biến duy nhất nhìn thấy, scope Preview. Không thấy `NEXT_PUBLIC_INTRACAMPUS_RPC_URL` trong danh sách project hiện tại. Tab Shared chưa kiểm tra. Vì `frontend/lib/chains.ts` lấy RPC trình duyệt từ `NEXT_PUBLIC_INTRACAMPUS_RPC_URL`, đây là một config gap có khả năng giải thích balance không đọc được nếu deployment live dùng đúng source này; cần xác nhận Shared scope/commit trước khi kết luận.
- **Đọc source tại worktree:** `frontend/app/student/PayInvoice.tsx`, `frontend/lib/payment.ts`, `frontend/lib/wallet.ts`, `frontend/lib/chains.ts`, `packages/network/src/chain.ts`, `infra/genesis.json` và `deployments/intracampus-cloud.json`.
- **Tra tài liệu Core chính thức:** Core dùng RPC của network đang active cho các yêu cầu `eth_*`; khi thêm custom network, Core kiểm tra chain ID RPC; `eth_sendTransaction` là wallet operation cần approval. Điều này khiến RPC có thể ảnh hưởng cả đọc balance lẫn dựng giao dịch, nhưng không chứng minh đây là nguyên nhân duy nhất.
- Không chạy test/build. Không có request/response JSON-RPC trực tiếp từ Core được thu lại trong lượt này.
- Không chạy đủ ba `curl` tới RPC thô: Vercel chỉ cho thấy `BACKEND_URL` nhưng giá trị bị masked/không đọc được, Core RPC URL trên screenshot bị cắt, và `.env` thật không có trong worktree. Thay vào đó đã chạy GET read-only `/api/network` trên Preview; phần `eth_getBalance` còn thiếu.

## Đánh giá hiện tại: bằng chứng và giả thuyết

### Đã xác nhận

1. App live và Core đang được dùng cho custom chain cloud `20261120`.
2. App không đọc xác minh được balance trong lần quan sát live gần nhất.
3. Vercel Preview `/api/network` trả đúng chain `20261120`, block 49, age 175 giây tại thời điểm probe.
4. Danh sách Project Environment Variables của Preview chỉ hiển thị `BACKEND_URL`; chưa thấy biến public RPC mà `browserWalletConfig()` đọc. Shared scope chưa xem.
5. UI đang khôi phục/tra cứu lượt parking cũ và không cho gửi lại.
6. Người dùng không thấy giao dịch đó trong Core Activity.
7. QR parking quan sát được đã hết hạn.

### Có khả năng, chưa chứng minh

- RPC trong Core không đúng hoặc không truy cập được, gây mất đọc balance và làm Core không chuẩn bị/mở được màn hình ký.
- Vercel Preview có thể thiếu `NEXT_PUBLIC_INTRACAMPUS_RPC_URL`; backend proxy vẫn healthy nên route `/api/network` chạy được trong khi browser wallet không đọc balance. Cần xác nhận env ở Shared scope và commit đang deploy.
- RPC Core và RPC app/backend không giống nhau. App có thể đọc chain qua `NEXT_PUBLIC_INTRACAMPUS_RPC_URL`, trong khi Core gửi request qua RPC cấu hình riêng của Core.
- CAMPUS chưa được Core nhận diện/hiển thị cho custom L1 hoặc asset cần được thêm thủ công nếu là ERC-20. Việc không có giá USD (`$-`) có thể chỉ là thiếu price feed, không nhất thiết là lỗi RPC.
- Provider có thể đã nhận lời gọi `eth_sendTransaction` nhưng trả lỗi chưa phân loại; app lưu `unknown` để an toàn. Điều này giải thích vì sao không mở lại nút, nhưng chưa giải thích lỗi đầu tiên.

### Chưa được kết luận

- Chưa chứng minh giao dịch đã được gửi hoặc đã bị từ chối bằng receipt/hash.
- Chưa chứng minh endpoint RPC trong Core là đúng/sai.
- Chưa chứng minh CAMPUS là native coin hay ERC-20 trên chain cloud đang chạy.
- Chưa kiểm tra trạng thái invoice/deployment live qua API/RPC ở thời điểm ghi tài liệu.
- Chưa tái hiện lỗi hộp thoại ký với một invoice parking mới.

## Việc tiếp theo

1. **Đối chiếu RPC trước khi gửi giao dịch mới:** đọc URL đầy đủ trong Core, so với RPC công khai của frontend/backend; không chia sẻ secret nếu URL có credential.
2. Với cùng RPC, kiểm tra read-only `eth_chainId`, `eth_blockNumber` và `eth_getBalance` cho ví student. Chain phải là `20261120`, head phải đọc được, balance phải khớp giữa Core và app/RPC độc lập.
3. Kiểm tra nativeCurrency (`CAMPUS`, 18 decimals) và xác minh CAMPUS trên online L1 là native coin hay contract token. Nếu ERC-20, đối chiếu contract address và dùng `wallet_watchAsset`/thêm token thủ công nếu Core hỗ trợ; nếu native, tập trung vào network RPC/balance.
4. Không dùng lại invoice parking đã hết hạn. Sau khi RPC đọc tốt, tạo invoice mới ở POS; bấm thanh toán một lần và ghi nhận ngay: trạng thái UI, Core popup/error, Core Activity và tx hash nếu có. Không gửi lần hai khi kết quả còn `unknown`.
5. Với trạng thái `unknown` cũ, đối chiếu backend/chain và journal trước khi xóa hoặc mở lại. Không xóa localStorage như bước đầu vì journal đang bảo vệ chống trả trùng.
6. Tái hiện riêng lỗi nộp cọc thư viện bằng yêu cầu mới và kiểm tra nút “nộp cọc” trước khi sửa giao diện.

## Cập nhật sửa lỗi ngày 2026-11-21

Đã kiểm tra trực tiếp endpoint HTTPS Quick Tunnel đang chạy trên VM:

- `eth_chainId` trả `0x1352900` (`20261120`), `eth_blockNumber` trả `0x35` tại lần đọc gần nhất.
- `eth_getBalance(0x0A3298bB7C6bCE6094188C2755468DEefCBB4bA3)` trả `0xa2a15d09519be00000`, bằng **3.000 CAMPUS** với 18 decimals. Nonce `latest` và `pending` đều là `0x0`. Không có căn cứ để kết luận ví thiếu tiền hoặc có giao dịch gửi xe đã phát sinh.
- CORS preflight từ Preview origin `https://intracampus-l1-jsbs4s4gv-ae-12-t.vercel.app` ban đầu và sau sửa đều trả `204` cùng `Access-Control-Allow-Origin` khớp. Preflight từ Core Chrome extension origin `chrome-extension://agoakfejjabomempkjlepdflaleeobhb` ban đầu trả `403`.
- Đã sửa allowlist gateway trên VM để giữ Preview origin và cho phép đúng Core extension origin; không dùng wildcard. Đã cập nhật `infra/rpc-gateway.mjs` để kiểm tra HTTP(S) origin chính xác hoặc Chrome extension origin đúng định dạng, và ghi chú vận hành ở `infra/rpc.md`. Restart `intracampus-phase3b-rpc.service` thành công. Sau sửa, cả hai preflight đều trả `204`; JSON-RPC vẫn trả đúng chain ID và balance.
- Người dùng vừa xác nhận Core đã hiện CAMPUS sau thay đổi CORS. Đây là bằng chứng Core đã đọc được asset của chain; chưa chứng minh hỗ trợ giá USD, nên `$-` có thể vẫn bình thường.
- Shared Environment Variables của Vercel project trống. Đã tạo `NEXT_PUBLIC_INTRACAMPUS_RPC_URL` với endpoint HTTPS hiện tại và `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120`, cả hai scope **Preview**, không chọn Production. Project chưa kết nối Git repository nên chọn Preview chung thay vì scope branch.
- Redeploy đầu tiên sau khi chỉ thêm RPC hoàn thành nhưng trang hiển thị chain local `20261`; source mặc định chain ID này khi thiếu biến public chain ID. Đã thêm biến chain ID cloud rồi redeploy Preview lần hai; deployment hiện tại Ready tại `https://intracampus-l1-gufnfidol-ae-12-t.vercel.app/student`, và header app hiển thị chain `20261120`.
- Trên deployment mới, app thấy `eth_chainId=43113` từ provider và chưa có account permission cho origin mới. Đã bấm `Kết nối ví`, chỉ kích hoạt `eth_requestAccounts`; UI hiện `Đang chờ ví`. Không gửi giao dịch, không yêu cầu ký. Cần chủ ví chấp thuận kết nối site trong Core để frontend được phép đọc address/balance; sau đó mới xác nhận balance app.

### Trạng thái sau cập nhật

- **Core không hiện CAMPUS:** nguyên nhân CORS đã được chứng minh; gateway đã sửa và người dùng xác nhận token hiện lên.
- **Frontend không đọc balance:** RPC và chain ID đã được thêm cho Preview; deployment mới có chain ID đúng `20261120`. Còn chờ người dùng chấp thuận kết nối Core trên origin deployment mới để kiểm tra balance trực tiếp trong giao diện.
- **Popup ký parking:** chưa tái hiện sau sửa. CORS là nguyên nhân khả dĩ vì Core đã bị chặn RPC, nhưng cần invoice mới, thao tác thanh toán một lần và quan sát popup/Activity/hash để xác nhận. Không dùng invoice đã hết hạn, không gửi lại nếu kết quả còn `unknown`.

## Working tree

Tại lúc tạo tài liệu, worktree đã có nhiều file sửa đổi và một số file mới thuộc các phase trước. Trong lượt sửa 2026-11-21, `infra/rpc-gateway.mjs` và `infra/rpc.md` được cập nhật có chủ đích cho allowlist Chrome extension. Không reset hay sửa các thay đổi có sẵn khác. Xem `git status` trước khi tích hợp hoặc deploy tiếp.

## Cập nhật sau khi kết nối Preview ngày 2026-11-21

- Đã kết nối Core trên origin mới `https://intracampus-l1-gufnfidol-ae-12-t.vercel.app`; provider hiện báo chain `20261120`.
- Tìm thấy cấu hình CORS VM chỉ có origin Preview cũ `jsbs4s4gv...` và Core extension origin; origin mới `gufnfidol...` chưa nằm trong danh sách. Đã thêm đúng origin Preview mới, giữ lại hai origin cũ, không dùng wildcard; `intracampus-phase3b-rpc.service` restart và báo `active`.
- Sau cập nhật, OPTIONS từ origin Preview mới trả `204` và `Access-Control-Allow-Origin` đúng origin đó. POST JSON-RPC từ cùng origin trả `200`, `eth_getBalance` thành công. App live hiện **2.998,99 CAMPUS**, dữ liệu đã xác minh; tier 1 và thẻ #1 còn hiệu lực. Đây là kết quả đã kiểm tra trên giao diện, không chỉ từ API.
- Nonce ví student hiện `latest=1`, `pending=1`, head `0x3f`. Quét block `0x36`–`0x3f` thấy một giao dịch trong block `0x3e`: hash `0xba5bdb853e10f9d1db1e7d38267ff189f128c92839566a2a1603882a7a6da686`, từ ví student tới ví canteen đã cấu hình, `value=1 CAMPUS`, receipt `status=0x1`, calldata rỗng (`0x`), không có logs. Phí receipt là `0.000084 CAMPUS` (`gasUsed=0x5208`, giá gas `0xee6b2800` wei). Lượt sửa hiện tại không tạo giao dịch này; nguồn thao tác/thời điểm gửi chưa được xác định. Vì đây là native transfer trực tiếp tới ví canteen chứ không có event hóa đơn, chưa thể gắn nó với invoice parking đang hiển thị; app hiện báo không tìm thấy hóa đơn POS tương ứng. Số dư chính xác RPC trả hiện là `2,998.999916 CAMPUS`; giao diện hiển thị hai chữ số thập phân (`2.998,99`).
- Ở lượt này chỉ kiểm tra/đọc RPC và receipt; không gửi giao dịch, không ký, không xóa journal hay thay đổi payload invoice.

### Trạng thái mới nhất

- **CORS/Core assets:** đã sửa allowlist cho đúng origin; người dùng trước đó xác nhận Core hiện CAMPUS.
- **Balance app Preview:** đã xác minh hiển thị 2.998,99 CAMPUS và thẻ tier 1 trên chain `20261120`.
- **Vấn đề popup ký parking:** vẫn chưa được tái hiện có kiểm soát và transaction trên không khớp được invoice parking; không dùng lại invoice cũ, không bấm thanh toán lần nữa khi invoice chưa được xác minh. Để tiếp tục, cần invoice mới do POS phát hành rồi quan sát UI/Core/receipt một lần.

## Kiểm tra và sửa lỗi POS Preview ngày 2026-11-21

- Ảnh người dùng gửi cho thấy route sinh viên vẫn mở, nhưng POS báo không tìm thấy invoice tương ứng. Mở trực tiếp `/pos` xác nhận trang tải; khi gửi GET `/api/network`, deployment Preview trả `{"status":"not-configured","expectedChainId":20261}`.
- SSH chỉ đọc trên VM xác nhận backend cổng `4000` trả `not-configured`/chain local `20261`; backend Phase 3B cổng `4100` trả `ready`/chain cloud `20261120`. Public Quick Tunnel cũ của `4000` được cấu hình trong `BACKEND_URL` Preview; Quick Tunnel của `4100` là `https://palmer-sphere-aluminum-facilities.trycloudflare.com` và probe trực tiếp trả `ready`.
- Đã cập nhật `BACKEND_URL` ở **chỉ Preview** sang API Quick Tunnel cổng `4100`; giữ Production không đổi. URL Quick Tunnel có thể đổi khi service khởi động lại, khi đó cần cập nhật lại `BACKEND_URL` và redeploy.
- Redeploy đúng source Preview hiện tại `codex/intracampus-phase-3b`; Vercel Ready tại `https://intracampus-l1-plg18vzrd-ae-12-t.vercel.app` (deployment `HscpcqjfxML8oh5hePArPZ7uXwev`). GET `/api/network` trên deployment mới trả `ready`, `expectedChainId=chainId=20261120`, block 69.
- Mở `/pos` trên deployment mới xác nhận giao diện hiện “Tạo hóa đơn POS”, trạng thái “Sẵn sàng cho lượt thanh toán tiếp theo” và nút “Tạo hóa đơn”; không còn cảnh báo backend/network. Không bấm tạo hóa đơn, không gửi giao dịch và không ký ví.
- Đây là bản sửa riêng cho định tuyến POS backend. Nó không thay đổi cấu hình RPC của Core hoặc frontend balance, và không redeploy Production. Ghi chú này cập nhật các dòng cũ phía trên nói balance còn chờ xác minh: balance Preview đã được kiểm tra trước đó ở mức 2.998,99 CAMPUS.

## Trạng thái Production Vercel khi rà tài liệu ngày 2026-11-21

- Dashboard cho thấy alias Production `https://intracampus-l1.vercel.app` đang trỏ tới một deployment CLI cũ từ branch `feat/ui-receipt-gate-mobile`; project chưa kết nối Git repository.
- Preview của branch `codex/intracampus-phase-3b` ở trạng thái Ready tại `https://intracampus-l1-plg18vzrd-ae-12-t.vercel.app`; các biến `BACKEND_URL`, `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID` và `NEXT_PUBLIC_INTRACAMPUS_RPC_URL` hiện chỉ có scope Preview.
- Chưa promote source lên alias Production: cần cấu hình ba biến cloud cho Production cùng allowlist origin backend/RPC, nếu không deployment mới có thể về chain local hoặc làm luồng API/wallet lỗi.
- Đây là trạng thái được quan sát trong dashboard ngày 21/11; Vercel, hostname tunnel và cấu hình VM có thể thay đổi. Đối chiếu lại trước mỗi lần publish; quy trình nằm trong [runbook cloud](../cloud-deployment.md).
