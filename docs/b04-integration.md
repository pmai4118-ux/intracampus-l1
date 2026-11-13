# B04 · Ghép POS, invoice và receipt thật

B04 dùng POST B01, GET B02 và manifest L06 chung. U04 sở hữu việc ví Core sinh viên ký/gửi giao dịch; B04 không gửi thanh toán thay sinh viên. Giữ nguyên giao kèo P02 và dùng chuỗi wei trong JSON.

## Nguồn tích hợp

Nhánh B04 bắt đầu từ main `3b1d136`, ghép source L05/L06 từ `05f9c98` (bao gồm `eba14b8`). L05/L06 chưa nằm trên main tại lúc ghép. Khi giải quyết conflict, giữ test frontend, P02, L04 và L06. Không merge hoặc deploy thay nhóm.

Manifest canonical `deployments/intracampus.json` hiện là `unconfigured`; chưa có bằng chứng B04 trên L1. `http://127.0.0.1:3000` là web local, không phải RPC hay đường HTTPS cho hai thiết bị.

## Phạm vi nghiệm thu

1. B01/U02/B02 dùng cùng verifier, SBT, merchant, POS signer, ABI và deployment block từ L06; chặn cấu hình lệch.
2. POS phát hành invoice thật, theo dõi GET và chỉ hiện thành công khi có receipt đã xác minh. Reload khôi phục invoice cũ bằng GET, không POST/pay lại.
3. Backend dùng SQLite trên volume bền vững; receipt đã commit còn đọc được sau restart và khi RPC mất kết nối.
4. Hai thiết bị truy cập Student/POS qua HTTPS cùng origin; lưu payload, tx hash, ảnh receipt và log lỗi đã loại secret.

## Trạng thái bằng chứng

- HTTP/SQLite: `node --test backend/test/b04-integration.test.ts` đạt: POST ký thật → GET pending → RPC 503 → reverted/mismatch 422 → paid → mở lại cùng DB → GET paid khi RPC tắt. B02 chỉ phát một `invoice_paid`.
- Trình duyệt Chrome ở `http://127.0.0.1:3104/pos` qua Next rewrite tới backend fixture loopback: tạo QR, reload khôi phục cùng invoice, RPC offline không báo thành công, phục hồi nhận paid, restart backend + RPC offline + reload vẫn paid. Thông báo live không lặp sau reload. [Response lưu sau restart](fixtures/b04-http-evidence.json) là JSON-RPC tổng hợp, không phải giao dịch EVM/L1.
- [Bằng chứng Anvil thực](fixtures/b04-local-evidence.json): source được loader L04 xác minh, chain 20261; tier 0 trả 3.000 CAMPUS, tier 1 trả 2.700; cả hai giữ hash khi RPC lỗi và đọc lại receipt sau mở SQLite. Hash trong file chỉ có ý nghĩa trên Anvil tạm đã dừng, không phải L1.
- Source cuối: `pnpm typecheck`, `pnpm build` đạt. `pnpm test`: 281 pass, 0 fail, 1 test Anvil B03 tùy chọn skip (backend 146, frontend 63, P02 35, L04 loader 5, L06 export 32). `pnpm test:rpc`: 18 pass khi dùng Git Bash; bash mặc định Windows trỏ WSL chưa bật virtualization nên hai Bash entry-point test ban đầu không chạy được. Không sửa source để che lỗi môi trường.
- `forge fmt --check`, `forge build`, `forge test` đạt; 69 test Solidity. `pnpm smoke:l06` đạt deploy/export/seed hai lần/grant trên Anvil tạm, không thay manifest canonical. CI GitHub chưa chạy cho nhánh B04 vì chưa push.
- Hai checkpoint review chỉ có self-review: lần 1 Codex không tạo được PATH alias trong sandbox; lần 2 sau khi người dùng cho phép gửi diff, reviewer dừng vì model mặc định `gpt-6-luna` không được tài khoản Codex ChatGPT hỗ trợ. Không có verdict APPROVE từ reviewer ngoài. Self-review bổ sung hai regression test cho phản hồi pending cũ không hạ trạng thái paid và lỗi transport/JSON không lộ nội dung exception. Có thể chạy lại review-impl sau khi chủ cấu hình chọn model reviewer được tài khoản hỗ trợ. Thành viên khác vẫn cần review/nghiệm thu theo AGENTS.md.
- Các kết quả trên không xác nhận HTTPS hai thiết bị, ví Core hoặc L1 thật. RPC hiện trả unreachable; chưa publish, deploy hay cập nhật trạng thái bảng sprint.

## Cấu hình canonical

Khi manifest đã deploy lên L1, backend lấy registry/block, merchant bãi xe, signer công khai và SBT từ manifest. Biến `PARKING_MERCHANT_ADDRESS` hoặc registry/block nếu còn đặt phải khớp. Trước phát hành, khóa POS phải đúng role signer; registry phải trả cùng signer/SBT và bật merchant/category PARKING tại cùng block. Khóa vẫn chỉ nằm trong `POS_SIGNER_PRIVATE_KEY` phía backend.

U02/U03 lấy SBT, verifier và signer từ cùng manifest; `NEXT_PUBLIC_*` địa chỉ nếu còn đặt phải khớp. RPC công khai vẫn lấy từ môi trường và được kiểm tra chain 20261. Manifest unconfigured chỉ giữ đường cấu hình thủ công phục vụ phát triển/fixture, không xác nhận deployment L1.

## Điểm nối POS / U04

`frontend/lib/invoice-status.ts` cung cấp `InvoiceStatusController` và `parseInvoiceLookup`. POS dùng `watch(invoiceId, envelope?, txHash?)`, `refresh(txHash?)`, `restore()` và `dispose()`. U04 có thể dùng controller hoặc gọi GET hiện có với `?txHash=...` sau khi chính ví sinh viên gửi. Backend cũng tìm event theo invoiceId, vì vậy hai thiết bị không cần chia sẻ state trình duyệt để POS thấy thanh toán.

POS chỉ gửi POST khi người vận hành bấm tạo. Nó poll GET tuần tự khoảng 2 giây, dùng Retry-After khi 503, backoff 2/4/8/16/30 giây khi mất kết nối. `pending`, `expired`, `rpc-error`, `reverted`, `event-mismatch` không tạo thông báo thành công. Dừng poll khi paid; vẫn tra cứu invoice hết hạn để nhận receipt đến muộn. Có form nhập invoiceId/txHash để đối chiếu thủ công.

Trình duyệt giữ invoiceId và hash chưa có kết luận (kể cả request chưa được backend xác nhận); reload GET lại invoice đó. Chỉ receipt hợp lệ có khóa `(chainId, contractAddress, txHash, logIndex)` mới tạo thông báo lần đầu; đọc lại cùng receipt không thông báo lại. Storage bị chặn thì UI nêu rõ cần giữ invoiceId/hash để phục hồi thủ công. U04 vẫn cần lưu hash phía Student và làm mới preflight trước khi mở Core; `InvoiceStatus.tsx` của B04 không chiếm file `Receipt.tsx` đề xuất cho U04.

## Dựng đường HTTPS và volume

Chạy một backend Node 24 trên host có volume bền vững. Đặt `INVOICES_DB_PATH` thành absolute path trên volume (ví dụ `/var/lib/intracampus/invoices.sqlite`); giữ cả các file WAL đi kèm, không đặt DB trong filesystem tạm của serverless. B01 và B02 đã dùng chung một repository trong `server.ts`. Khi reset mạng/deploy registry khác, giữ DB cũ để đối chiếu và dùng DB mới cho deployment mới.

Next.js proxy `/api/invoices` và `/api/invoices/:path*` đã có. Đặt `BACKEND_URL=https://<backend-host>` khi backend chạy riêng; backend phải listen vào interface mà reverse proxy tiếp cận được (đặt HOST theo môi trường). Nếu Next/backend cùng host, có thể dùng loopback HTTP nội bộ và terminate TLS tại reverse proxy ở web. Cấu hình origin web public `https://<app-host>` cho cả `/pos` và `/student`; browser chỉ gọi `/api/invoices` cùng origin. Không cần mở wildcard CORS cho Express. RPC public riêng phải HTTPS và cho phép origin web theo L02.

Deploy backend và build frontend từ cùng source/manifest. Các biến public được bundle lúc build: đổi manifest/RPC thì rebuild frontend, restart backend. Chạy `pnpm rpc:check` phải trả ready / chainId 20261 trước khi sử dụng L1. Health check riêng không chứng minh deployment/RPC sẵn sàng.

## Checklist nghiệm thu L1 còn lại

- [ ] Operator L06 cung cấp manifest `status: deployed`, `environment: avalanche-l1`, địa chỉ/block/hash/ABI/role/merchant đã xác minh; RPC HTTPS truy cập được. Manifest trong repo hiện unconfigured, RPC kiểm tra hiện unreachable.
- [ ] Triển khai web/API qua HTTPS và volume; thiết bị A mở POS, thiết bị B mở Student với Core. Xác nhận cả hai dùng cùng origin và chain 20261.
- [ ] POS tạo invoice mới; Student/U04 xác nhận bằng Core. Lưu nguyên payload công khai, invoiceId, tx hash và receipt/event thật. Đối chiếu giá gốc/giảm/đã trả, merchant, verifier, signer, SBT và block triển khai.
- [ ] Khi giao dịch đang chờ, ngắt RPC: POS không báo thất bại hay thành công giả; giữ hash, không trả lại. Khôi phục RPC rồi tra hash cũ.
- [ ] Reload POS và restart backend trên cùng volume; receipt đã commit vẫn paid. Lưu ảnh receipt ở cả hai thiết bị và log lỗi đã bỏ secret. Revert/mismatch/receipt-null không được báo paid.
- [ ] CI trên source kết hợp đạt và một thành viên khác review. Chỉ reviewer nghiệm thu mới đánh dấu Xong.

## Tái tạo local

Tại gốc repo: `node --test backend/test/b04-integration.test.ts` và `node --test frontend/test/invoice-status.test.ts`.

EVM: `forge build` trong `contracts`, mở Anvil loopback `127.0.0.1:18547` với `--chain-id 20261 --silent`, rồi tại gốc repo chạy `node backend/test/b04-local-evidence.ts <output.json>`. Script chỉ chấp nhận Anvil loopback cố định, dùng tài khoản demo mặc định, không đọc khóa/RPC môi trường. Dừng Anvil sau khi chạy. Output ghi rõ local và không thay manifest canonical.

UI fixture: chạy `node backend/test/b04-browser.ts` (port 4104), mở Next ở port 3104 với `BACKEND_URL=http://127.0.0.1:4104`; các lệnh stdin `offline`, `paid`, `restart` dùng để kiểm tra. Đây là test harness riêng dưới `backend/test`, không được expose lên mạng hay dùng như backend L1; kết thúc bằng `quit` và dừng Next.
