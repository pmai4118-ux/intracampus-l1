# Đăng nhập, xác minh sinh viên và học bổng

Phạm vi bổ sung theo yêu cầu người dùng ngày 2026-11-20, chưa có mã task sprint. Thay đổi chỉ thêm luồng ứng dụng; không thay ABI, triển khai hợp đồng, cấp tiền thật hoặc cập nhật bảng sprint.

## Các trang

| Đường dẫn cùng host `http://127.0.0.1:3000` | Chức năng |
| --- | --- |
| `/login` | Kết nối Core/MetaMask và ký đăng nhập không tốn gas trên chain đã chọn: `20261` local hoặc `20261120` cloud |
| `/student/verification` | Gửi hồ sơ, xem kết quả, đăng ký học bổng và theo dõi khoản cấp |
| `/staff/students` | Ví được nhà trường phân quyền duyệt hồ sơ và mở ví cấp tiền |
| `/student`, `/student/canteen`, `/student/library` | Ví và các dịch vụ sinh viên hiện có |
| `/pos`, `/staff/canteen`, `/staff/library` | Công cụ vận hành hiện có, giữ cơ chế phân quyền riêng |

## Cấu hình

Dùng Node 24, `pnpm install --frozen-lockfile` và cấu hình web/API theo [run-local.md](run-local.md). Không thay thế `.env` đã có của đồng đội. Bổ sung các biến sau ở backend:

| Biến | Ý nghĩa |
| --- | --- |
| `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID` | Chọn chain nhất quán cho frontend và backend: `20261` local hoặc `20261120` cloud |
| `CAMPUS_AUTH_ORIGIN` | Origin frontend chính xác, ví dụ `http://127.0.0.1:3000`, không kèm path; cloud dùng origin Vercel đang chạy |
| `LIBRARY_AUTH_ORIGIN` | Origin chính xác cho đăng nhập dịch vụ sinh viên; cấu hình cùng origin với Campus |
| `LIBRARY_ALLOW_INSECURE_LOCALHOST=true` | Chỉ cho HTTP loopback local; môi trường khác bắt buộc HTTPS |
| `CAMPUS_SCHOOL_WALLETS` | Danh sách địa chỉ ví duyệt, ngăn bằng dấu phẩy. Có cả ví quỹ và grantIssuer nếu họ cần cấp tiền |
| `CAMPUS_TREASURY_ADDRESS` | Ví EOA được phép trả quà chào mừng; phải có ít nhất 20 CAMPUS và gas mỗi lượt |
| `CAMPUS_DB_PATH` | Đường dẫn SQLite bền vững; cloud bắt buộc đường dẫn tuyệt đối, khác ba DB còn lại và nằm trên volume persistent |
| `CAMPUS_SCHOLARSHIP_WEI` | Số tiền một học bổng, số nguyên wei dương; mặc định `1000000000000000000000` (1000 CAMPUS) |
| `INTRACAMPUS_RPC_URL` | RPC có head mới và đúng chain được chọn bởi `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID` |
| `CAMPUS_ALLOW_LOCAL_ANVIL` | Mặc định false. Chỉ bật cho manifest local và RPC loopback tường minh |

Trên cloud, `CAMPUS_TREASURY_ADDRESS` phải là ví EOA đang giữ CAMPUS và cũng phải có trong `CAMPUS_SCHOOL_WALLETS`; nếu không, ví quỹ không thể tạo lượt cấp quà chào mừng. Ví `grantIssuer` chỉ cần nằm trong danh sách này nếu nó sẽ đăng nhập để duyệt hồ sơ hoặc chuẩn bị giải ngân FOOD. `ADMIN_FUNDER_PRIVATE_KEY` là signer khác cho thao tác **Bắn CAMPUS test** trong `/admin`; nó chuyển từ số dư đang có trên VM và không tự cấp quyền Native Minter. Quyền Native Minter được quản lý riêng trên chain.

Campus dùng `CAMPUS_AUTH_ORIGIN`, dự phòng `LIBRARY_AUTH_ORIGIN`. Thiếu/sai origin làm endpoint Campus trả 503, không mở quyền tạm. Challenge có hạn 5 phút, phiên 1 giờ; giới hạn challenge 10 và verify 20 yêu cầu mỗi 60 giây theo cơ chế auth hiện có. Cookie Campus tách khỏi cookie dịch vụ cũ. Frontend proxy `/api/campus/*` theo `BACKEND_URL`; không có biến frontend nào chứa private key.

Học bổng lấy địa chỉ, runtime code hash, grantIssuer và category căn-tin từ manifest được chọn theo chain: `20261` dùng `deployments/intracampus.json`, `20261120` dùng `deployments/intracampus-cloud.json`. Không lấy đích hợp đồng từ form. Chưa có deployment đã xác minh thì vẫn đăng nhập/duyệt được nhưng không giải ngân. Chạy `pnpm rpc:check` trước thao tác trên L1. Không dùng faucet Fuji hoặc nhầm AVAX với CAMPUS.

## Đưa demo cloud lên Vercel và GCP

Vercel chạy frontend. Backend/API, RPC gateway và SQLite chạy trên VM GCP; node cloud có RPC nội bộ riêng. Ví Core và trình duyệt dùng RPC HTTPS công khai của gateway. Không đặt SQLite trên filesystem của Vercel. Chi tiết luồng và kiểm tra ở [runbook cloud](cloud-deployment.md).

Trên Vercel, cấu hình ở đúng scope Preview/Production rồi redeploy vì `NEXT_PUBLIC_*` được nhúng lúc build và `BACKEND_URL` được đọc khi tạo rewrite:

- `BACKEND_URL`: origin HTTPS của backend cloud. Các rewrite cùng origin chuyển `/api/campus/*`, `/api/auth/*`, `/api/library/*`, `/api/invoices/*`, `/api/grants/*`, `/api/canteen/*` và `/api/parking/*` tới backend. Biến này không phải RPC URL.
- `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120` và `NEXT_PUBLIC_INTRACAMPUS_RPC_URL`: RPC HTTPS công khai của gateway mà trình duyệt/Core truy cập được. Gateway cần allowlist CORS đúng origin web và origin extension Core; RPC nội bộ backend cấu hình riêng qua `INTRACAMPUS_RPC_URL`.
- Các địa chỉ public `NEXT_PUBLIC_STUDENT_SBT_ADDRESS`, `NEXT_PUBLIC_CAMPUS_PAYMENT_REGISTRY_ADDRESS` và `NEXT_PUBLIC_CAMPUS_POS_SIGNER_ADDRESS` phải khớp manifest cloud. Giữ `NEXT_PUBLIC_ALLOW_LOCAL_ANVIL=false`; không đưa khóa hoặc RPC token bí mật vào `NEXT_PUBLIC_*`.

Trên backend GCP, đặt `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120`, `INTRACAMPUS_RPC_URL` nội bộ của cloud, manifest cloud, `CAMPUS_AUTH_ORIGIN` và `LIBRARY_AUTH_ORIGIN` khớp origin Vercel, cùng các ví public trong `CAMPUS_SCHOOL_WALLETS`, `CAMPUS_TREASURY_ADDRESS` và `PARKING_MERCHANT_ADDRESS`. `CAMPUS_ALLOW_LOCAL_ANVIL` phải là `false`. Một backend chỉ chấp nhận origin được cấu hình; URL Preview ngẫu nhiên có thể không đăng nhập được nếu khác origin đó, nên dùng alias ổn định hoặc cấu hình đúng origin cho môi trường đang nghiệm thu.

Cloud yêu cầu bốn SQLite path tuyệt đối, khác nhau và bền vững: invoices, library, canteen và `CAMPUS_DB_PATH`. Đặt chúng trên persistent disk của VM; nếu thiếu hoặc trùng, backend dừng thay vì chạy Campus với DB tạm. Demo không yêu cầu bật backup riêng; tạo lại VM/đĩa có thể làm mất dữ liệu. Trước khi dùng Production, kiểm tra `/api/network`, `/api/deployment`, `/api/campus/me`, đăng nhập, cấp tiền và các route POS trên cùng origin HTTPS.

## Quy trình

1. Sinh viên mở `/login`, kết nối ví và ký thông điệp. Ví chưa có CAMPUS vẫn ký đăng nhập được. Chữ ký chỉ chứng minh quyền sở hữu ví, không duyệt hồ sơ.
2. Ở `/student/verification`, gửi mã sinh viên (4–32 ký tự chữ/số/gạch nối) và khoa/chương trình. Không tải căn cước, bảng điểm hay khóa ví lên hệ thống.
3. Nhà trường dùng ví nằm trong allowlist mở `/staff/students`. Đối chiếu mã với dữ liệu chính thức, xác nhận ví được đúng sinh viên ủy quyền, đánh dấu đã kiểm tra rồi duyệt. Có thể yêu cầu bổ sung để sinh viên gửi lại. Một mã chỉ duyệt cho một ví; hồ sơ đã duyệt không tự chỉnh sửa.
4. Ví quỹ chọn **Xem lượt cấp 20 CAMPUS**, kiểm tra ví nhận/số tiền/chain và bấm **Xác nhận và mở ví cấp**. API kiểm tra chain, head mới và mô phỏng gas trước khi khóa lượt cấp. Người giữ ví quỹ tự ký giao dịch. UI chỉ báo đã nhận sau receipt thành công và giao dịch khớp đầy đủ. Quà này vào số dư native của sinh viên.
5. Sinh viên đã duyệt có thể đăng ký diện khuyến khích học tập hoặc hỗ trợ. Nhà trường xét hồ sơ theo quy định riêng rồi duyệt học bổng. Người giữ ví grantIssuer mở lượt giải ngân, xem số tiền và ký `grant()` có đủ tài sản cấp vào FOOD vault. Chỉ event `GrantIssued` khớp ví/category/issuer/amount mới xác nhận giải ngân. Duyệt học bổng chưa có nghĩa đã chuyển tiền.
6. Sinh viên đã duyệt bấm **Kích hoạt dịch vụ sinh viên** để thêm tài khoản STUDENT vào dịch vụ hiện có và ký phiên dịch vụ. Cấu hình Library/auth hiện có vẫn phải đầy đủ theo [library-backend.md](library-backend.md). Tài khoản bị tắt hoặc role khác không được bật lại/đổi role. Phê duyệt này không mint SBT hoặc tự cấp mức giảm giá on-chain.

MVP giữ một hồ sơ đã duyệt, một quà chào mừng và một học bổng đã cấp trên mỗi ví; không mô hình hóa học kỳ/nhiều đợt. Danh sách nhà trường hiển thị tối đa 200 hồ sơ gần nhất. Tiêu chí học bổng được cán bộ đối chiếu ngoài hệ thống, chưa có tích hợp dữ liệu đào tạo hay chấm điểm tự động.

## Lưu trữ và khôi phục

SQLite giữ hồ sơ, quyết định và người duyệt, phiên đăng nhập cùng lượt cấp. Mã sinh viên/chương trình chỉ trả cho chủ ví và ví nhà trường; không đưa vào QR, calldata hoặc log. Calldata quà chào mừng chỉ chứa mã lượt cấp ngẫu nhiên. Giữ SQLite và WAL trên volume bền vững, dùng backup SQLite phù hợp; không seed lại/xóa DB khi triển khai vì đó là bằng chứng chống cấp lặp. Chưa hỗ trợ đổi ví sinh viên, thu hồi xác minh hoặc chuyển ví quỹ cho một lượt đã chuẩn bị; cần quy trình quản trị riêng.

Lượt cấp đi qua `PREPARED → UNKNOWN → PENDING → CONFIRMED`; receipt revert khớp giao dịch được lưu `FAILED` và UI nói rõ chưa cấp tiền. Khóa được ghi trên server trước khi gọi ví. Nếu WalletController xác nhận provider từ chối giao dịch (`4001`) hoặc lỗi xảy ra trước khi gọi gửi, UI khôi phục **cùng lượt cấp** về PREPARED để người dùng chủ động thử lại. Không tạo khoản cấp mới hoặc tự mở lại ví. Nếu mất phản hồi khôi phục, nút **Khôi phục lượt chưa gửi** thử lại đúng thao tác này trong tab hiện tại, không gọi gửi tiền.

Trình duyệt tạo token ngẫu nhiên 256 bit và giữ capability khôi phục trong tab **trước** khi gửi `begin`. Body là `{attemptToken}`; response vẫn là `{payout, attemptToken}`. Nếu mất phản hồi sau khi server commit, client chưa gọi ví nên có thể release bằng token đã giữ. Không tự gọi lại ví. Retry begin với cùng token của UNKNOWN chưa hash trả lại cùng attempt; token khác vẫn bị khóa.

Nếu phiên hết hạn trước khi khôi phục lượt chưa gửi, ký đăng nhập lại bằng cùng ví ngay trên trang nhà trường, rồi mở lượt cấp và bấm **Khôi phục lượt chưa gửi**. Token vẫn nằm trong bộ nhớ của trang qua bước đăng nhập lại.

Server chỉ lưu hash token, không trả token qua payout/profile/list hoặc log. `release` cần phiên đúng ví cấp và kết quả REJECTED/NOT_SENT. UNKNOWN chưa hash chỉ được release bằng đúng token hiện tại; nếu begin chưa commit và payout còn PREPARED, release ghi dấu hủy token để begin tới muộn không khóa lại. Dấu hủy được giữ cả sau những attempt tiếp theo và khôi phục từ bảng attempt cũ khi khởi động. Việc khôi phục là atomic và idempotent; token đã hủy bị từ chối khi begin lại. Đây là xác nhận từ luồng client chưa gọi gửi hoặc từ WalletController của ví cấp đã đăng nhập, không phải bằng chứng từ RPC. Không có endpoint reset tùy ý cho người xem hoặc cán bộ khác.

Timeout sau gọi provider, kết quả chưa rõ, hash đã gắn, receipt revert, đóng tab hoặc mất token vẫn giữ khóa. Mở lại hồ sơ, chọn lượt cấp cũ và dùng hash từ lịch sử ví để **Đối chiếu giao dịch**. Hash đã lưu chỉ gắn một lượt và không thay bằng hash khác qua API. Nếu chưa có hash hoặc hash không khớp, người vận hành phải đối chiếu lịch sử/nonce/receipt ngoài ứng dụng trước khi quyết định xử lý. UNKNOWN từ phiên bản cũ không có token cũng không tự được mở. Giữ DB/backup để điều tra, không sửa tay để bỏ khóa khi chưa xác định kết quả.

Receipt cần block sau mốc chuẩn bị, canonical hash kiểm tra lại, from/to/value/calldata/chain khớp và status thành công. Policy hiện tại xác nhận tại một block canonical; không có worker theo dõi reorg hoặc danh sách giao dịch thay thế. Có thể đối chiếu lại hash đã lưu. Đây là giới hạn MVP, không phải cam kết finality bổ sung của mạng.

## API và kiểm tra

Tất cả endpoint dưới `/api/campus`, trả `Cache-Control: no-store`. POST kiểm tra Origin và giới hạn JSON 8 KiB; session lấy từ cookie HttpOnly, không nhận wallet chủ hồ sơ từ client.

| Endpoint | Quyền / dữ liệu |
| --- | --- |
| `POST /auth/challenge`, `/auth/verify`, `/auth/logout`; `GET /auth/session` | Challenge một lần và phiên sở hữu ví |
| `GET /me` | Ví hiện tại, cờ school từ server và hồ sơ của chính ví |
| `POST /applications` | `{studentCode, program}`; trạng thái chờ xét |
| `POST /scholarships` | `{category: "MERIT" | "SUPPORT"}`; cần sinh viên đã duyệt |
| `POST /activate` | `{}`; thêm STUDENT đã xác minh, không thay quyền có sẵn |
| `GET /reviews` | Chỉ ví nhà trường; danh sách hồ sơ |
| `POST /reviews` | Chỉ nhà trường; `{wallet, kind: "STUDENT" | "SCHOLARSHIP", approve, reason}` |
| `POST /payouts` | Chỉ nhà trường; `{wallet, kind: "WELCOME" | "SCHOLARSHIP"}`; trả lượt cũ nếu đã có |
| `POST /payouts/:id/begin` | Chỉ đúng ví cấp; `{attemptToken}` do client tạo/giữ trước request; mô phỏng và khóa một lần; retry cùng token idempotent; trả `{payout, attemptToken}` |
| `POST /payouts/:id/release` | Chỉ đúng ví cấp; `{attemptToken, outcome: "REJECTED" | "NOT_SENT"}`; khôi phục cùng lượt chưa gửi, không mở lượt đã có hash |
| `POST /payouts/:id/reconcile` | Chỉ nhà trường; `{txHash}`; đối chiếu giao dịch cũ |

Lỗi có dạng `{error:{code}}`, gồm 401 chưa đăng nhập, 403 sai quyền/điều kiện, 409 trùng danh tính hoặc lượt cấp đã khóa, 429 rate limit và 503 cấu hình/RPC chưa sẵn sàng. Không có endpoint mint CAMPUS hoặc giữ private key nhà trường.

`backend/test/campus.test.ts` kiểm tra chữ ký/nonce/replay/logout, quyền HTTP/Origin, danh tính duy nhất, xét học bổng riêng, mô phỏng trước khóa, lưu hash khi RPC lỗi, từ chối receipt sai và recovery theo ví/attempt. Test HTTP tích hợp với client thật kiểm tra commit rồi mất cả response begin/release, không gọi ví trước khi khôi phục và chỉ gửi một lần sau thao tác thử lại. Test race kiểm tra release vượt begin đang chờ mô phỏng. `frontend/test/campus.test.ts` kiểm tra preview, challenge lỗi, logout 204, provider 4001, retry sau hủy, lỗi chưa rõ giữ khóa và token đã có trước HTTP. Các test dùng ví ngẫu nhiên, SQLite trong bộ nhớ và RPC fixture; không phải bằng chứng giao dịch L1 thật.
