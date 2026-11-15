# N-47121905 — Thư viện Student

Trang `/student/library` dùng ví và session thật, gọi `/api/auth/*` và `/api/library/*` qua Next cùng origin. Mở từ điều hướng Thư viện hoặc nút trên `/student`.

## Chạy và demo

1. Dùng Node 24, pnpm 11.25.0; cài dependencies theo lockfile.
2. Cấu hình backend theo `docs/library-backend.md`: manifest đã xác minh, SQLite persistent, catalog/account demo, auth origin đúng origin Next và chain freshness có giá trị tường minh.
3. Frontend dùng `BACKEND_URL` server-side và `NEXT_PUBLIC_INTRACAMPUS_RPC_URL` công khai. SBT/verifier/signer và Library Escrow cùng lấy từ manifest chuẩn. Với Anvil cô lập, đặt `NEXT_PUBLIC_ALLOW_LOCAL_ANVIL=true`; chỉ chấp nhận RPC HTTP loopback. Mặc định không cho manifest local làm cấu hình ví thật. Rebuild frontend khi đổi cấu hình công khai.
4. Chạy `pnpm dev`, mở `/student/library`, chọn ví Student demo trên 20261 rồi bấm **Ký đăng nhập thư viện**. Đây là chữ ký, chưa chuyển tiền.
5. Tìm theo tên/tác giả/ISBN, tạo yêu cầu, đọc cọc/giá thay thế, ví, chain, escrow và quy chế trước khi **Xác nhận và mở ví**. Tạo yêu cầu chưa giữ bản. Cọc xác nhận chỉ chuyển sang chờ thủ thư duyệt; chỉ event approve mở khoản mượn.
6. Bấm **Làm mới trạng thái** để đọc quyết định thủ thư hoặc receipt mới. Sinh viên gửi yêu cầu trả, đưa sách cho thủ thư, xem breakdown sau settlement. Hết hạn duyệt có thể nhận lại cọc; sách mất có phần thiếu thì kiểm tra số tiền rồi ký bằng ví đã mượn.

Luồng Thủ thư tại `/staff/library` dùng session và ví librarian để duyệt, nhận sách và quyết toán. Pilot dưới đây thao tác những bước đó qua UI; hướng dẫn thủ thư nằm trong `docs/n696-library-librarian.md`.

## Recovery

Giao dịch lưu journal trước khi gọi ví, scope theo chain/escrow/deployment transaction/account/request/action. Web Locks ngăn hai tab gửi cùng action; hỏng storage hoặc thiếu Web Locks thì không ký. Hash trả về được lưu kể cả account đổi khi popup mở.

Khi kết quả chưa rõ: dùng **Đối chiếu** để đọc request/event hoặc nhập hash từ lịch sử ví. Receipt pending/null/RPC lỗi không có nghĩa thất bại; không xóa journal và không tự gửi lại. Receipt revert cũ không được dùng để mở khóa lần gửi mới mất hash. Chỉ từ chối ví chắc chắn chưa gửi hoặc receipt revert của đúng lần gửi mới cho phép retry. Nếu journal hỏng, giữ request ID/hash và phục hồi storage/đối soát trước khi ký thêm.

Hold chặn tạo/cấp lại cọc nhưng vẫn giữ đọc lịch sử, yêu cầu trả, refund và shortfall. API session phải khớp ví đang chọn; đổi account/chain unmount dữ liệu riêng và bản xem trước, giữ journal của ví cũ.

## Điểm nâng cấp UI

- `LibrarySession.tsx`: điều phối session, tải dữ liệu và form xác nhận inline.
- `LibraryCatalog.tsx`, `LibraryRequests.tsx`, `LibraryLoans.tsx`: thành phần hiển thị theo props, có thể thay bố cục mà không thay logic tiền.
- `library-api.ts`: parse response, same-origin cookie, lỗi/Retry-After.
- `library-transactions.ts`: canonical calldata/amount preflight, khóa và journal/recovery.
- `library.ts`: nhãn trạng thái, thông báo và thời gian.

Style tái sử dụng Student/POS, thêm class `library-*`; breakpoint 56rem/28rem, mobile 390px. Form có label, button native, status/alert và focus xác nhận; không thêm UI framework hoặc theme.

## Kiểm tra

Focused: `node --test frontend/test/library-student.test.ts frontend/test/library-transactions.test.ts frontend/test/b04-config.test.ts`.

Gates: `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check`.

Pilot trình duyệt có chủ đích trong `frontend/test/library-student-pilot.mjs`. Chuẩn bị bản sao disposable có `.cross-review` trong đường dẫn, copy `frontend`, `backend`, `packages`, `docs`, `deployments` cùng package/workspace/lockfile và cài dependencies. Không copy `.env`, DB, node_modules hoặc build cũ. Copy source mới nhất trước mỗi lượt; manifest đầu vào của bản sao phải là bản `unconfigured` gốc (backend invoice codec hiện chỉ nạp manifest production khi import). Checkout task không bị thay manifest.

Khởi động **Anvil mới, riêng cho pilot** chain 20261 với block-time 1 trên cổng loopback trống. Cấp `LIBRARY_ANVIL_URL` và `LIBRARY_PILOT_ISOLATED=true`, rồi chạy:

```sh
node frontend/test/library-student-pilot.mjs <disposable-copy> <contracts-out-dir> <playwright-package-dir>
```

Artifact directory cần bytecode đã build của StudentSBTIdentity, CampusPaymentRegistry, PurposeBoundGrantVault và LibraryDepositEscrow. Playwright dùng Chrome đã cài, chạy headless bằng profile test riêng. Next dùng cổng 3129; cổng phải trống. Không chạy song song hai pilot. Pilot chỉ deploy ví demo/unlocked trên Anvil được chỉ định, seed DB mới, dùng Next + Express thật và provider fixture trong browser harness. Nó không ký bằng Core extension và không phải bằng chứng L1. Script tắt browser/Next/API; người vận hành tắt Anvil riêng sau lượt chạy. Không reset chain/DB của người dùng.

Evidence JSON và screenshot mobile/desktop được ghi cạnh bản sao. Các ca gồm login cookie thật, search empty, cọc chưa ACTIVE, unknown-send/reload chỉ một broadcast, approve qua UI thủ thư, return/settlement, shortfall, refund hết hạn, reject/recovery sau reload, responsive và đổi ví. N-75 còn phụ trách toàn bộ matrix tích hợp; manual Core/L1 ghi `NOT_RUN` đến khi có bằng chứng riêng.
