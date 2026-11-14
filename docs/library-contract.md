# Giao kèo module thư viện v1

**Trạng thái:** candidate của Phase 1; cần qua checkpoint review trước khi các task phụ thuộc triển khai. [Fixture `library-v1.json`](fixtures/library-v1.json) khóa ABI, route, trạng thái, policy và vector tiền dùng chung. Fixture không phải bằng chứng contract đã deploy.

## Mạng và tiền

- Chain ID `20261`; CAMPUS native có 18 decimals. JSON truyền wei bằng chuỗi số nguyên không âm; TypeScript dùng `bigint`, không dùng `number` để tính tiền.
- Tiền cọc chính xác `50000000000000000000` wei (50 CAMPUS) cho mỗi request. Giá thay thế lấy từ terms đã seal trong escrow và seed SQLite. Browser và thủ thư không thể chọn giá authoritative.
- Sinh viên/thủ thư tự ký mọi giao dịch bằng Core. Backend đọc chain, tạo calldata công khai và xác minh receipt/event; không giữ khóa ký hoặc broadcast thay người dùng.
- `requestId` là `bytes32` ngẫu nhiên do server tạo, giữ xuyên suốt request/loan/refund và không bao giờ dùng lại. Sau duyệt, `loanId=requestId`. DB bảo đảm một loan cho mỗi request và một request đang giữ cho mỗi `copyId` vật lý.

## Ranh giới policy

| Quy tắc | Biên chính xác |
| --- | --- |
| Cọc và giữ copy | Tạo intent chưa giữ copy. Chỉ receipt thành công có event `DepositReceived` khớp mới gán một copy SQLite. |
| Duyệt | Deadline bằng `depositedAt + 86400` giây theo chain. Chỉ duyệt khi `block.timestamp < deadline`; đúng deadline thì đóng duyệt và mở refund. |
| Hạn trả | `approvedAt + 1209600` giây (14 ngày). |
| Ân hạn | `259200` giây đầu sau `dueAt` (3 ngày) không tính phí trễ. |
| Phí trễ | `floor(max(0, returnedAt - dueAt - 259200) / 86400) * 0.1 CAMPUS`, trần 25 CAMPUS. Khoảng 24 giờ chưa đủ không tính. |
| Ngưỡng giữ toàn cọc | Đúng `dueAt + 2592000` (trễ 30 ngày) vẫn quyết toán như trả thường. Chỉ khi `returnedAt > dueAt + 2592000` mới giữ toàn bộ cọc 50 CAMPUS. |
| Sách hỏng | Phí trễ và phần sửa thực thu cộng lại không vượt cọc. `repairFeeWei` là phần thực thu; `maintenanceRequired` vẫn true nếu thủ thư đã báo hỏng nhưng cọc bị dùng hết cho khoản khác. |
| Mất sách | Quyết toán theo giá thay thế đã seal, không cộng phí trễ. Hoàn phần cọc dư hoặc ghi đúng số thiếu; hold còn đến khi xác minh receipt trả thiếu. |

Fixture khóa các ca: ngay trước/đúng/sau kỳ phí 24 giờ đầu; đúng ngày 30; sau ngày 30 một giây; phí sửa cộng phí trễ; giá sách thấp/bằng/cao hơn cọc. Test Anvil có thể điều khiển block time; ứng dụng chỉ dùng chain time đã xác minh.

## Danh tính và session

`POST /api/auth/challenge` nhận `{ "wallet": "0x…" }`. Server tạo thông điệp EIP-4361 gắn domain, chain `20261`, nonce ngẫu nhiên dùng một lần, thời điểm tạo và hạn hết hiệu lực do operator cấu hình; lưu đúng thông điệp cần ký. `POST /api/auth/verify` nhận `{ "challengeId": "…", "signature": "0x…" }`, xác minh đúng thông điệp đó rồi tiêu thụ nonce một lần. Server lấy role từ allowlist; client không được chọn role `STUDENT`/`LIBRARIAN`.

Đăng nhập thành công cấp session opaque, lưu hash ở server và đặt cookie `HttpOnly`, `SameSite=Strict`, `Secure` khi dùng HTTPS; logout thu hồi session. Write request kiểm tra `Origin`/CSRF theo origin ứng dụng đã cấu hình. HTTP loopback chỉ được phép theo policy local tường minh. Session/nonce thiếu hoặc sai phải từ chối. TTL challenge/session và rate limit là cấu hình operator bắt buộc, không tự đặt default production.

Ví `LIBRARIAN` trong allowlist phải khớp getter `librarian()` của escrow. Role trong web session không tự cấp quyền on-chain.

## Vòng đời request và loan

API tách status của request, loan, refund và transaction. Deposit đã xác minh chỉ chuyển request sang `PENDING_APPROVAL`; loan vẫn `NONE`. Chỉ event `LoanApproved` đã xác minh mới tạo loan `ACTIVE`. Hash giao dịch, lời gọi mở ví hay HTTP thành công không đủ để đổi trạng thái.

| Event/điều kiện đã xác minh | Request | Loan | Refund | Copy |
| --- | --- | --- | --- | --- |
| Tạo intent | `AWAITING_DEPOSIT` | chưa có | `NONE` | còn trống |
| Receipt deposit, `BEGIN IMMEDIATE` gán được copy | `PENDING_APPROVAL` | chưa có | `NONE` | đang giữ |
| Receipt deposit nhưng hết copy do race | `REJECTED_NO_COPY` | chưa có | `REFUND_DUE` | không đổi |
| Receipt thủ thư từ chối | `REJECTED` | chưa có | `REFUNDED` | chỉ nhả sau receipt |
| Đến deadline, chain time đã xác minh | `EXPIRED_REFUND_DUE` | chưa có | `REFUND_DUE` | nhả tại/sau deadline, không chờ claim |
| Receipt `LoanApproved` | `APPROVED` | `ACTIVE` | `NONE` | đang mượn |
| Sinh viên gửi yêu cầu trả | `RETURN_REQUESTED` | `RETURN_REQUESTED` | `NONE` | đang mượn |
| Receipt `ReturnSettled` | `RETURNED` | `RETURNED` | `NONE` | sẵn sàng hoặc bảo trì khi có báo hỏng |
| Receipt `LostSettled` còn thiếu tiền | `LOST_SHORTFALL_DUE` | `LOST_SHORTFALL_DUE` | `NONE` | mất |
| Receipt `ShortfallPaid` | `LOST_SETTLED` | `LOST_SETTLED` | `NONE` | mất |

Contract không đọc được tồn kho SQLite. Vì vậy staff queue chỉ cho duyệt request đã giữ copy; backend kiểm tra lại việc gán trước khi trả calldata approve và UI không có nút duyệt cho `REJECTED_NO_COPY`. Quyền contract vẫn thuộc ví librarian đã cấu hình.

## HTTP API

Express phục vụ các route sau qua proxy Next.js cùng origin. Trường tiền là chuỗi wei. Session trả `{ account: { wallet, role }, expiresAt }`; lỗi trả `{ error: { code, message, retryable } }`.

| Method và path | Quyền | Request/hành vi |
| --- | --- | --- |
| `POST /api/auth/challenge` | công khai | `{ wallet }`; trả challenge ID và đúng thông điệp để ký. |
| `POST /api/auth/verify` | công khai | `{ challengeId, signature }`; tiêu thụ nonce và đặt session cookie. |
| `GET /api/auth/session` | session | Trả wallet, role server-resolved và hạn session. |
| `POST /api/auth/logout` | session | Thu hồi session và xóa cookie. |
| `GET /api/library/books?q=…` | session | Tìm theo title/author/ISBN đã seed; trả terms giá/cọc đã seal và số copy còn. |
| `GET /api/library/requests` | session | Sinh viên chỉ thấy request mình; `?queue=true` chỉ librarian được xem hàng chờ có copy đã giữ. |
| `POST /api/library/requests` | `STUDENT` | `{ bookId, idempotencyKey }`; idempotent theo borrower/key, chỉ tạo intent nếu hiện có copy. Chưa giữ copy. Trả request ID và `depositIntent` (`chainId`, `to`, `data`, `valueWei`). |
| `GET /api/library/requests/:requestId` | chủ sở hữu hoặc `LIBRARIAN` | Trả request, refund/transaction, event proof đã xác minh và loan nếu có. Người khác nhận `404` theo scope. |
| `POST /api/library/requests/:requestId/transactions` | chủ sở hữu hoặc `LIBRARIAN` | `{ action, txHash }`; action `return`/`settle` còn bắt buộc `settlementIntentId` để gắn receipt với audit intent đã lưu. Ghi nhận giao dịch đã được ví ký, không broadcast. |
| `GET /api/library/loans` | session | Sinh viên thấy loan của mình; librarian có thể lọc danh sách staff bằng query `borrowerWallet`. |
| `POST /api/library/loans/:loanId/return-requests` | `STUDENT` | Ghi yêu cầu trả idempotent; không tự xác nhận thủ thư đã nhận sách vật lý. |
| `POST /api/library/loans/:loanId/settlement-intents` | `LIBRARIAN` | `{ outcome: "RETURNED", condition, reason, repairRequestedWei }` hoặc `{ outcome: "LOST", reason }`; `condition` là `GOOD`/`DAMAGED`, `reason` là chuỗi bắt buộc không rỗng sau trim. Trả audit `intentId`, preview theo chain time và calldata ví cho `settleReturn`/`settleLost`. |
| `GET /api/library/account-status` | session | Trả hold, chain-time check và loan đang chặn; luôn truy cập được khi hold. |

Idempotency key được scope theo borrower: cùng borrower/key/book trả lại cùng request; cùng borrower/key nhưng khác book trả `409`. Action ánh xạ đúng ABI như sau: `deposit` → `deposit`, `approve` → `approve`, `reject` → `reject`, `refund` → `claimExpiredRefund`, `return` → `settleReturn`, `settle` → `settleLost`, `payShortfall` → `payShortfall`. `deposit`, `refund` và `payShortfall` chỉ do đúng borrower ký; `approve`, `reject`, `return` và `settle` chỉ do librarian ký. Dù contract cho phép bất kỳ ai claim expired refund, app API chỉ cấp giao dịch đó cho borrower của request.

`settlement-intents` trả `LibrarySettlementIntent`: `intentId` opaque do server cấp, `requestId`, `loanId`, `outcome`, `borrower` (người nhận refund/shortfall), `chainId`, `escrow`, `treasury`, `walletCall { to, data, valueWei }`, `preview` dạng `LibrarySettlement` và `chainTime` đã xác minh. Backend persist audit intent vào SQLite trước khi trả response/calldata: intent ID, request/loan, actor wallet từ session librarian, outcome, condition (nếu trả), reason đã trim, repair amount (nếu trả) và createdAt. `reason`/condition chỉ dùng cho audit staff, không vào calldata/event và không trả cho Student. Khi ví gửi giao dịch, transaction tracking bắt buộc `settlementIntentId` cho action `return`/`settle` để liên kết action/hash/receipt với audit intent; các action khác không gửi trường này. `LibraryLoan` cũng mang `borrower`; staff UI hiển thị borrower, treasury, escrow, network và khoản tiền trước khi mở ví. Preview không phải settlement đã hoàn tất; chỉ receipt/event đã xác minh mới cập nhật loan. Caller, contract/backend consumer, persistence, proof và test owner của từng action được khóa trong `callerMatrix` của fixture.

Mọi Library JSON `POST` dùng giới hạn parser `8kb` giống `POST /api/invoices`, tương đương `8192` byte. Parser chấp nhận body tới đúng 8192 byte; từ 8193 byte trả `413 PAYLOAD_TOO_LARGE`. Hằng `LIBRARY_REQUEST_BODY_LIMIT_BYTES` trong network package và fixture vectors giữ một mức dùng chung.

Backend kiểm tra chain ID, contract, sender/value/calldata và receipt canonical thành công trước khi chiếu trạng thái; event phải khớp request ID, borrower, book terms và action. Receipt đang chờ trả `202`; receipt revert giữ status `REVERTED`; RPC mơ hồ/không tới được để trạng thái chưa rõ và có thể retry cùng action/hash. Gửi lại cùng action/hash idempotent; hash mâu thuẫn với action đã ghi trả `409`. Không tự gửi lại giao dịch ví.

Tại/sau approval deadline, đường đọc/reconcile lấy chain time tin cậy để cập nhật expiry và giải phóng copy; refund là vòng đời riêng. Chỉ có một backend instance, không phụ thuộc indexer/WebSocket. Invoice, grant và mượn mới dùng chung hold guard dựa trên chain time mới. Login, health/network, account status, return, refund, settlement và trả shortfall vẫn hoạt động khi hold.

## Mã lỗi

| Code | HTTP | Ý nghĩa |
| --- | ---: | --- |
| `VALIDATION_ERROR` | 400 | Body/path không hợp lệ. |
| `PAYLOAD_TOO_LARGE` | 413 | JSON body vượt giới hạn parser 8192 byte. |
| `UNAUTHENTICATED` | 401 | Thiếu, hết hạn hoặc sai session. |
| `FORBIDDEN` | 403 | Sai role/chủ sở hữu/quyền hành động hoặc đang bị hold. |
| `NOT_FOUND` | 404 | Không tồn tại hoặc ngoài phạm vi người gọi. |
| `CONFLICT` | 409 | Xung đột copy/idempotency/state hoặc hash giao dịch. |
| `INTERNAL_ERROR` | 500 | Lỗi bất ngờ; không báo thành công một phần. |
| `RPC_UNAVAILABLE`, `WRONG_CHAIN`, `STALE_CHAIN_STATE` | 503 | Không xác minh an toàn được chain/state/time; chặn thao tác thường, giữ đường khôi phục mở. |
| `DATABASE_BUSY` | 503 | SQLite writer bận; retry cùng key/action, không giả định transaction đã commit. |
| `CONFIGURATION_ERROR` | 503 | Thiếu hoặc sai domain một cấu hình operator bắt buộc; không dùng production default ngầm. |

Operator cấp các key dưới đây qua cấu hình môi trường trước khi chạy; schema có kiểu `number` là số nguyên an toàn của JavaScript. Sản phẩm không gán production default. Thiếu key, parse lỗi hoặc sai domain trả `503 CONFIGURATION_ERROR` cho thao tác phụ thuộc vào key đó; không âm thầm thay bằng giá trị khác.

| Key | Đơn vị | Miền hợp lệ | Dùng cho |
| --- | --- | --- | --- |
| `challengeTtlSeconds` | giây | số nguyên an toàn `>= 1` | Hạn challenge đăng nhập |
| `sessionTtlSeconds` | giây | số nguyên an toàn `>= 1` | Hạn session |
| `challengeRateLimit.maxRequests` | request/window | số nguyên an toàn `>= 1` | Số challenge tối đa trong cửa sổ |
| `challengeRateLimit.windowSeconds` | giây | số nguyên an toàn `>= 1` | Cửa sổ giới hạn challenge |
| `verifyRateLimit.maxRequests` | request/window | số nguyên an toàn `>= 1` | Số verify tối đa trong cửa sổ |
| `verifyRateLimit.windowSeconds` | giây | số nguyên an toàn `>= 1` | Cửa sổ giới hạn verify |
| `chainFreshness.maxStaleSeconds` | giây | số nguyên an toàn `>= 1` | Tuổi block tối đa trước khi từ chối chain state/time |
| `chainFreshness.maxFutureDriftSeconds` | giây | số nguyên an toàn `>= 0` | Độ lệch tương lai tối đa của block time |
| `chainFreshness.minConfirmations` | block | số nguyên an toàn `>= 1` | Confirmation tối thiểu trước khi chốt projection |

`LibraryRuntimeConfig` và `LibraryRateLimitConfig` trong `packages/network/src/library.ts` giữ tên/đơn vị cùng schema này. Các giá trị sample trong test chỉ kiểm tra domain; chúng không phải cấu hình production. Sai chain, block time cũ/tương lai hoặc thiếu manifest vẫn trả `503` như đã quy định.

## ABI và điểm nhận event

Constructor, function, getter, error, tên/thứ tự/index của event và mutability đều được khóa trong [fixture](fixtures/library-v1.json):

- Admin seed `seedBookTerms(bookId, depositWei, replacementPriceWei)` rồi gọi `sealBookTerms(bookId)`. Terms đã seal không đổi được; DB seed phải khớp terms on-chain.
- Borrower gọi payable `deposit(requestId, bookId)` với đúng cọc. Request ID không được dùng lại, kể cả đã refund hay kết thúc.
- Librarian gọi `approve` trước deadline hoặc `reject`. Bất kỳ ai cũng có thể gọi `claimExpiredRefund` tại/sau deadline; tiền luôn về borrower ban đầu.
- Librarian gọi `settleReturn(requestId, repairRequestedWei)` sau khi nhận sách vật lý hoặc `settleLost(requestId)`. Borrower ký `payShortfall` với đúng số còn thiếu.
- Backend chỉ nhận projection từ receipt thành công và event khớp tại địa chỉ Library Escrow đã cấu hình trên chain `20261`. Commit DB trước khi API báo trạng thái đã đổi. Khởi động lại và reconcile theo request/read phải idempotent.

`docs/test/library-contract.test.mjs` so sánh toàn bộ ABI chuẩn hóa, bao gồm constructor, mutability/returns của function, indexed fields của event và toàn bộ error set; thêm entry chưa được duyệt làm test thất bại. Vectors deadline trong fixture khóa `deadline - 1`, đúng deadline và `deadline + 1`: chỉ trước deadline được duyệt; tại/sau deadline, refund đến hạn và copy được nhả trước cả khi borrower claim refund.

Trước Phase 2, worker contract và lead review fixture này để freeze ABI. Mọi chênh lệch là lỗi phase gate; frontend/backend không tự thêm tương thích để che khác biệt.
