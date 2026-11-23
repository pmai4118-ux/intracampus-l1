# Bàn giao & Vận hành trang quản trị test ẩn `/admin`

> **Phạm vi:** Bổ sung theo yêu cầu ngày 2026-11-21 (mã PR tự tạo `[N-9E4C2B71]`), gộp chung điều chỉnh bỏ dropdown chọn diện học bổng trên `/login` & `/student/verification` (chỉ giữ nút **Gửi đăng ký học bổng FOOD**).
>
> **Nguyên tắc bảo mật:** Không lưu `ADMIN_ACCESS_KEY`, private key signer, URL RPC nội bộ hoặc nội dung `.env` thật vào Git, frontend `NEXT_PUBLIC_*`, log chia sẻ hay tài liệu này. Key cố định của nhóm được cấp riêng qua kênh nội bộ và chỉ đặt trong `.env` backend.

---

## 1. Kiến trúc & mục đích

Trang `/admin` là bảng điều khiển nội bộ phục vụ đội ngũ test trên bản cloud (`20261120`) và local (`20261`):

1. **Ẩn khỏi UI công khai:** Không có liên kết từ trang chủ, ví sinh viên hay thanh điều hướng `AppNav` ([AppNav.tsx](../frontend/app/components/AppNav.tsx)). Route `/admin` gắn thẻ `robots: { index: false, follow: false, nocache: true }` ([page.tsx](../frontend/app/admin/page.tsx)).
2. **Xác thực bằng key cố định của nhóm (không khóa theo ví):**
   - Màn hình khóa tối giản nhập key → gửi `POST /api/admin/auth/login` qua Next.js rewrite cùng origin ([next.config.ts](../frontend/next.config.ts)).
   - Backend so khớp `ADMIN_ACCESS_KEY` bằng `SHA-256` + `timingSafeEqual`, giới hạn số lần nhập sai theo IP, cấp cookie `HttpOnly` (`__Host-admin_session` trên HTTPS hoặc `admin_session` trên localhost) lưu trên SQLite của GCP VM ([admin.repository.ts](../backend/src/modules/admin/admin.repository.ts)), cho phép cả nhóm dùng chung một key trên nhiều máy/trình duyệt.
3. **Đồng bộ ví đích động toàn hệ thống:**
   - Khi `/admin` cập nhật ví đích, backend lưu runtime config vào `admin.sqlite` (với Bãi xe / Nhà ăn / Campus) và thực thi giao dịch on-chain tương ứng bằng signer key đặt trên VM ([admin.signer.ts](../backend/src/modules/admin/admin.signer.ts)).
   - Toàn bộ ứng dụng đọc cấu hình ví đang hoạt động qua `GET /api/config/runtime` (`Cache-Control: no-store`) và qua callback resolver động ở các module `invoices`, `parking`, `canteen`, `grants`, `campus`, `library`.

---

## 2. Cấu hình triển khai (GCP VM + Vercel)

### 2.1. Backend trên Google Cloud VM (`.env`)

Đối chiếu [backend/.env.example](../backend/.env.example) và [cloud-deployment.md](cloud-deployment.md). Bổ sung vào `.env` backend trên VM (hiện tại là tiến trình phục vụ cloud `20261120`):

| Biến môi trường | Bắt buộc | Mô tả cho cloud demo (`20261120`) |
| --- | --- | --- |
| `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID` | Có | `20261120` (nếu bỏ trống sẽ fallback về local `20261` vốn có manifest `unconfigured`). |
| `ADMIN_ACCESS_KEY` | Có | Key cố định dùng chung của nhóm (tối thiểu 8 ký tự, khuyến nghị >= 16). Nếu bỏ trống, toàn bộ `/api/admin/*` khóa an toàn (`503`). |
| `ADMIN_AUTH_ORIGIN` | Có | Origin HTTPS chính xác của Vercel, hỗ trợ nhiều URL ngăn cách dấu phẩy (ví dụ `https://app.vercel.app,https://preview.vercel.app`). Dự phòng về `CAMPUS_AUTH_ORIGIN` / `LIBRARY_AUTH_ORIGIN`. |
| `ADMIN_ALLOW_INSECURE_LOCALHOST` | Không | Để `false` trên VM/cloud. Chỉ đặt `true` khi chạy thử HTTP trên `localhost`/`127.0.0.1`. |
| `ADMIN_SESSION_TTL_SECONDS` | Không | Mặc định `43200` (12 giờ), tối đa `604800` (7 ngày). |
| `ADMIN_DB_PATH` | Khuyến nghị | Đường dẫn tuyệt đối tới SQLite (ví dụ `/var/lib/intracampus/admin.sqlite`). Nếu bỏ trống khi chạy cloud `20261120`, [server.ts](../backend/src/server.ts) tự đặt `admin.sqlite` cùng thư mục `CAMPUS_DB_PATH`. |
| `ADMIN_REGISTRY_SIGNER_PRIVATE_KEY` | Tùy nhu cầu | Key ví `deployer` (`0x4488925B215899128a6eFE9c5efC111675F1acb1` trên cloud manifest) để đổi ví Bãi xe / Nhà ăn / allowlist trên `CampusPaymentRegistry`. |
| `ADMIN_LIBRARY_SIGNER_PRIVATE_KEY` | Tùy nhu cầu | Key `administrator` của `LibraryDepositEscrow` (nếu bỏ trống sẽ tự fallback sang `ADMIN_REGISTRY_SIGNER_PRIVATE_KEY`). |
| `ADMIN_SBT_ISSUER_PRIVATE_KEY` | Tùy nhu cầu | Key `sbtIssuer` (`0xC67497dCe89e3373f95aCe1a98b9270e8ab18329`) để cấp/cấp lại/thu hồi SBT (-10%). Có fallback sang `SEED_ISSUER_PRIVATE_KEY` nếu hợp lệ. |
| `ADMIN_GRANT_ISSUER_PRIVATE_KEY` | Tùy nhu cầu | Key `grantIssuer` (`0xA1Cb7975324Be2590b3Ae773526fcFcde25f794e`) để giải ngân học bổng `FOOD` vào `PurposeBoundGrantVault`. Có fallback sang `SEED_GRANT_ISSUER_PRIVATE_KEY` nếu hợp lệ. |
| `ADMIN_FUNDER_PRIVATE_KEY` | Có, nếu dùng mint CAMPUS cloud | Key funder giữ riêng trên VM. Trên chain `20261120`, signer cần quyền Native Minter Enabled/Manager/Admin và CAMPUS native để trả gas; trên local giữ luồng chuyển từ balance funder hiện có. |

> **Lưu ý khi thử trên máy local (`127.0.0.1`):**
> - `.env` và `.env.*` bị `.gitignore` chặn đồng bộ lên Git, nên cài key ở máy local không tự cập nhật lên GCP VM (và ngược lại).
> - Nếu chạy local mà chưa deploy bộ hợp đồng lên node `20261` (vì [deployments/intracampus.json](../deployments/intracampus.json) đang là `unconfigured`), `/admin` vẫn mở khóa và duyệt DB được, nhưng 4 thẻ đổi ví on-chain sẽ hiện cảnh báo *"Chưa có manifest triển khai..."* để chặn gửi giao dịch nhầm địa chỉ.

### 2.2. Nâng cấp `LibraryDepositEscrow` trên VM (nếu muốn đổi ví Thư viện on-chain)

[contracts/src/LibraryDepositEscrow.sol](../contracts/src/LibraryDepositEscrow.sol) đã chuyển `treasury` và `librarian` thành biến lưu trữ có thể cập nhật qua `setTreasury(address)` và `setLibrarian(address)` (chỉ `administrator` gọi được).

- Manifest cloud hiện có ([deployments/intracampus-cloud.json](../deployments/intracampus-cloud.json)) vẫn trỏ vào địa chỉ `LibraryDepositEscrow` cũ nên [@intracampus/network](../packages/network/src/library-deployment.ts) vẫn giữ tương thích đọc/kiểm chứng.
- Trước khi redeploy Escrow mới, `/admin` vẫn đổi được ví Bãi xe, Nhà ăn, tham số Campus, duyệt sinh viên, cấp SBT và cấp học bổng `FOOD`; riêng 2 thẻ **Treasury Thư viện** và **Thủ thư** sẽ khóa với mã `ESCROW_UPGRADE_REQUIRED`.
- Để mở khóa 2 nút đổi ví Thư viện trên chain `20261120` (giữ nguyên 3 hợp đồng core `StudentSBTIdentity`, `CampusPaymentRegistry`, `PurposeBoundGrantVault`):
  1. Deploy riêng `LibraryDepositEscrow` mới qua `DeployLibrary.s.sol` trên VM.
  2. Chạy `contracts/script/export-library-deployment.mjs` để cập nhật phần `library` trong `deployments/intracampus-cloud.json`.
  3. Commit/push manifest cập nhật (chỉ chứa địa chỉ/ABI/bằng chứng công khai) và deploy lại backend + Vercel.

### 2.3. Frontend trên Vercel

- Đảm bảo `BACKEND_URL` trỏ đúng origin HTTPS API trên GCP VM và `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120` theo [cloud-deployment.md](cloud-deployment.md).
- **Không** đưa `ADMIN_ACCESS_KEY` hay bất kỳ signer key nào lên Vercel Environment Variables.
- Sau khi push code mới (bao gồm [next.config.ts](../frontend/next.config.ts) rewrite `/api/admin/:path*` và `/api/config/:path*`), redeploy Vercel.

---

## 3. Hướng dẫn thao tác các tab trên `/admin`

1. **Tab 1 · Ví đích dịch vụ**
   - **Ví Bãi xe (`PARKING`)**: Nhập địa chỉ ví `0x...` mới → backend bật allowlist merchant mới trên `CampusPaymentRegistry` (tùy chọn tắt ví cũ), cập nhật resolver phát hành hóa đơn `/pos` và cấp quyền operator cổng ra `/staff/parking`.
   - **Ví Nhà ăn (`FOOD`)**: Nhập địa chỉ ví `0x...` mới → backend bật allowlist `FOOD` trên `CampusPaymentRegistry`, cập nhật resolver cho `CanteenService` & `GrantsService`. Các đơn đã `prepare` trước thời điểm đổi vẫn giữ nguyên `merchantAddress` đã ký lúc tạo đơn để không gãy đối chiếu ([canteen.ts](../packages/network/src/canteen.ts)).
   - **Ví nhận Thư viện (`treasury`)**: Gọi `LibraryDepositEscrow.setTreasury(newTreasury)`. Tiền phạt trễ, phí sửa chữa, cọc giữ lại và tiền bù mất sách sẽ về ví mới. Trang sinh viên khi gọi `payShortfall` và trang thủ thư quyết toán tự đọc ví `treasury` mới từ `/api/config/runtime`.
   - **Ví Thủ thư (`librarian`)**: Gọi `LibraryDepositEscrow.setLibrarian(newLibrarian)`, đồng bộ DB tài khoản thư viện (thu hồi session thủ thư cũ, mở quyền đăng nhập `LIBRARIAN` cho ví mới). Biên nhận/event lịch sử trước thời điểm đổi vẫn hợp lệ vì [library.verifier.ts](../backend/src/modules/library/library.verifier.ts) kiểm tra `librarian()` tại đúng `log.blockNumber`.
   - **Tham số Campus Onboarding & Allowlist mở rộng**: Ghi đè mức `CAMPUS_SCHOLARSHIP_WEI` mặc định và, trên local, địa chỉ `CAMPUS_TREASURY_ADDRESS`; cloud dùng Native Minter cho quà chào mừng. Có thể bật/tắt trực tiếp allowlist merchant bất kỳ trên `CampusPaymentRegistry`.

2. **Tab 2 · Tư cách sinh viên & SBT**
   - Dán địa chỉ ví test bất kỳ (hoặc chọn từ danh sách) để xem đồng thời trạng thái `campus_applications`, `library.sqlite` (enabled/held), số dư CAMPUS, số dư `FOOD` vault và thẻ `StudentSBTIdentity` on-chain.
   - Thao tác nhanh: **Duyệt SV & Mở dịch vụ**, **Từ chối SV**, **Mở/Khóa dịch vụ**, **Gỡ Hold test**, **Cấp / Cấp lại SBT (-10%)** (tự động chờ xác nhận `revoke` trước khi `mint` thẻ mới), **Thu hồi SBT**, và cấp/mint CAMPUS.
   - Trên cloud `20261120`, **Mint CAMPUS** gọi Native Minter bằng signer funder VM, tối đa 100.000 CAMPUS mỗi yêu cầu. Mỗi request có idempotency key và hash được lưu trước broadcast; nếu mất phản hồi, gửi lại cùng request thay vì tạo mint mới. Trên local `20261`, nút giữ hành vi chuyển từ số dư funder hiện có.
   - Khi duyệt hồ sơ sinh viên mới, backend tự mint đúng 20 CAMPUS một lần nếu signer có role Native Minter. Hồ sơ đã duyệt trước đây chỉ cấp qua thao tác **Cấp quà 20 CAMPUS (backfill)** trong phần tra cứu ví. Treasury cần tự ký một lần `setEnabled(funder)`; ứng dụng từ chối mint khi role chưa hoạt động. Không dùng giao dịch Core cho từng lượt.

3. **Tab 3 · Học bổng FOOD**
   - Chỉ hỗ trợ danh mục `FOOD` (không mở danh mục khác).
   - Duyệt/từ chối đơn đăng ký học bổng từ trang sinh viên và giải ngân trực tiếp bằng `PurposeBoundGrantVault.grant(wallet, keccak256("FOOD"))` từ ví `grantIssuer` trên VM.
   - Trên trang `/login` và `/student/verification` ([CampusPortal.tsx](../frontend/app/components/CampusPortal.tsx)), giao diện đã bỏ dropdown chọn diện học bổng và chỉ giữ lại một nút **Gửi đăng ký học bổng**.

4. **Tab 4 · Signers VM & Nhật ký**
   - Kiểm tra đủ năm signer trong `.env` trên VM đã nạp chưa, địa chỉ signer có khớp với vai trò trên manifest hay không, và cảnh báo nếu số dư gas dưới `1 CAMPUS`. Thẻ Native Minter hiển thị chain, địa chỉ funder, role allowlist và lý do chưa sẵn sàng.
   - Theo dõi nhật ký thao tác lưu trong `admin_audit_log` và kiểm tra lại trạng thái `txHash` nếu giao dịch đang ở trạng thái `SUBMITTED`.

---

## 4. API & Xử lý sự cố nhanh

### API chính (`Cache-Control: no-store`)

| Endpoint | Quyền | Chức năng |
| --- | --- | --- |
| `GET /api/config/runtime` | Công khai | Trả ví đang hoạt động (`parkingMerchant`, `canteenMerchant`, `libraryTreasury`, `libraryLibrarian`, `welcomeTreasury`, `scholarshipWei`) |
| `GET /api/admin/auth/session` | Công khai | Kiểm tra trạng thái phiên admin |
| `POST /api/admin/auth/login` | Origin + Key | Xác thực `ADMIN_ACCESS_KEY` (rate-limit theo IP) và đặt cookie phiên |
| `POST /api/admin/auth/logout` | Origin | Hủy phiên hiện tại |
| `GET /api/admin/overview` | Session | Tổng quan block, manifest, 4 kênh ví, số lượng hồ sơ, signer VM |
| `GET /api/admin/tx/:txHash` | Session | Poll receipt giao dịch và đồng bộ trạng thái `CONFIRMED` / `FAILED` vào audit log |
| `POST /api/admin/wallets/merchant` | Origin + Session | Đổi ví `PARKING` / `FOOD` |
| `POST /api/admin/wallets/registry-allowlist` | Origin + Session | Bật/tắt `setMerchantCategory` bất kỳ |
| `POST /api/admin/wallets/library-treasury` | Origin + Session | Gọi `setTreasury` trên `LibraryDepositEscrow` |
| `POST /api/admin/wallets/library-librarian` | Origin + Session | Gọi `setLibrarian` và đồng bộ tài khoản `LIBRARIAN` |
| `PUT /api/admin/campus-settings` | Origin + Session | Cập nhật runtime override `welcomeTreasury` / `scholarshipWei` |
| `GET /api/admin/students`, `GET /api/admin/students/:wallet` | Session | Liệt kê / kiểm tra chi tiết một ví |
| `POST /api/admin/students/review`, `PATCH /api/admin/students/:wallet/access` | Origin + Session | Duyệt/từ chối SV, mở/khóa dịch vụ, gỡ Library hold |
| `POST /api/admin/students/:wallet/welcome` | Origin + Session | Mint/đối chiếu quà chào mừng cho hồ sơ cloud đã duyệt trước đó; idempotent theo payout Campus |
| `POST /api/admin/students/:wallet/sbt/mint`, `.../sbt/revoke`, `.../fund` | Origin + Session | Cấp/thu hồi SBT; mint Native Minter trên cloud (tối đa 100.000 CAMPUS) hoặc chuyển balance funder trên local. Cloud request cần `requestId` UUID. |
| `POST /api/admin/scholarships/review`, `POST /api/admin/scholarships/grant` | Origin + Session | Duyệt hồ sơ và giải ngân học bổng `FOOD` |
| `GET /api/admin/audit` | Session | Đọc nhật ký thao tác quản trị |

### Lỗi thường gặp

| Triệu chứng / Mã lỗi | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| `503 CONFIGURATION_ERROR` khi mở `/admin` | VM chưa cấu hình `ADMIN_ACCESS_KEY` hoặc `ADMIN_AUTH_ORIGIN` | Kiểm tra `.env` backend trên VM, đặt đủ biến và restart backend |
| `403 FORBIDDEN` khi đăng nhập / bấm thao tác | Origin trình duyệt (ví dụ Preview URL mới trên Vercel) chưa nằm trong `ADMIN_AUTH_ORIGIN` | Thêm origin HTTPS đó vào `ADMIN_AUTH_ORIGIN` (ngăn cách dấu phẩy) và restart backend |
| `Chưa có manifest triển khai...` trên thẻ ví | Đang chạy profile local `20261` ([deployments/intracampus.json](../deployments/intracampus.json) ở trạng thái `unconfigured`) | Chạy cloud cần đặt `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120` đồng bộ ở Vercel và VM; chạy local cần deploy/export manifest `20261` |
| `ESCROW_UPGRADE_REQUIRED` | Contract `LibraryDepositEscrow` đang chạy trên chain chưa có `setTreasury`/`setLibrarian` | Redeploy riêng `LibraryDepositEscrow` và cập nhật `deployments/intracampus-cloud.json` |
| `SIGNER_ROLE_MISMATCH` | Private key đặt trong `.env` VM khác với địa chỉ quản trị/issuer đã deploy trong manifest | Mở tab **Signers VM & Nhật ký** để đối chiếu địa chỉ `Signer VM` với `Quyền on-chain` và cập nhật lại key đúng |
| `WRONG_CHAIN` | `INTRACAMPUS_RPC_URL` trả chain ID không khớp `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID` | Sửa đúng URL RPC của profile (`20261120` cho cloud, `20261` cho local) và chạy `pnpm rpc:check` |

---

## 5. Phạm vi kiểm thử & điểm chờ nghiệm thu L1

- **Đã kiểm tra và qua (local/fixture/mock, chưa phải bằng chứng L1 thật):**
  - Smart contract (`LibraryDepositEscrow` role updates, `forge fmt --check && forge build --force && forge test`): **94/94 tests qua** trong Foundry WSL.
  - TypeScript & toàn bộ bộ test tự động (`pnpm typecheck`, `pnpm test`, `node --test contracts/test/export-library-deployment.test.mjs`): qua cả backend (`admin.test.ts`, `campus`, `library`, `canteen`, `grants`, `invoices`), frontend (210/210) và contract fixtures.
  - Production build Next.js qua cả với `20261` và `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120`.
  - Smoke test HTTP cục bộ Next.js → Express (`20261120`): xác minh ẩn `AppNav`, `noindex`, đăng nhập key, cookie phiên, `/api/config/runtime` và đăng xuất.
- **Chờ nghiệm thu trên môi trường thật (`20261120` GCP VM + Vercel):**
  - Kiểm tra giao diện trình duyệt thực tế trực tiếp trên domain Vercel sau redeploy.
  - Test gửi giao dịch thật trên L1 cloud (`PARKING`/`FOOD` allowlist, cấp SBT, giải ngân `FOOD`, và `setTreasury`/`setLibrarian` sau khi redeploy `LibraryDepositEscrow`).
