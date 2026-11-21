# Hướng dẫn triển khai & nghiệm thu Phase 4 (Cloud Production + E2E)

**Ngày tạo:** 2026-11-21  
**Tiền điều kiện:** PR #41 (`feat/admin-test-console` → `main`) và [tài liệu hiện trạng Vercel/GCP/Core ngày 21/11](2026-11-21-vercel-gcp-core-wallet.md).  
**Tài liệu liên quan:** [docs/admin-console.md](../admin-console.md) · [docs/cloud-deployment.md](../cloud-deployment.md) · [docs/deployment.md](../deployment.md) · [AGENTS.md](../../AGENTS.md)

---

## 1. Tóm tắt hiện trạng đầu vào Phase 4

### Những gì đã hoàn tất ở Phase 3B & PR #41
- Chain cloud `20261120` đã có node trên GCP VM (`intracampus-demo-vm`, zone `asia-southeast1-b`) và manifest `status: "deployed"` trong [deployments/intracampus-cloud.json](../../deployments/intracampus-cloud.json).
- Gateway RPC (`infra/rpc-gateway.mjs`, service `intracampus-phase3b-rpc.service`) đã cập nhật CORS allowlist cho Chrome Core Extension `chrome-extension://agoakfejjabomempkjlepdflaleeobhb`.
- PR #41 đã hoàn thiện và qua toàn bộ CI cục bộ (Foundry 94/94, Backend 339/339, Frontend 210/210, Next.js build `20261` & `20261120`):
  - Trang quản trị test ẩn `/admin` (key cố định `ADMIN_ACCESS_KEY`, không cần nối ví, đồng bộ động qua `GET /api/config/runtime`).
  - `LibraryDepositEscrow.sol` bản hỗ trợ đổi ví `treasury` & `librarian` on-chain (`LibraryReceiptVerifier` kiểm tra lịch sử theo block).
  - Bỏ dropdown diện học bổng trên `/login` & `/student/verification`, giữ lại nút gửi đăng ký `FOOD`.

### Điểm còn tồn tại từ Phase 3B (phải xử lý trong Phase 4)
Theo [2026-11-21-vercel-gcp-core-wallet.md](2026-11-21-vercel-gcp-core-wallet.md):
1. **Vercel Production chưa đồng bộ**: Alias chính `https://intracampus-l1.vercel.app` vẫn trỏ bản CLI cũ (`feat/ui-receipt-gate-mobile`) và mới đặt `BACKEND_URL`, `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID`, `NEXT_PUBLIC_INTRACAMPUS_RPC_URL` ở scope **Preview**, chưa đặt ở **Production**.
2. **Backend trên VM đang chạy 2 cổng khác profile**: Cổng `4000` trả `20261` / `not-configured`; backend cloud `20261120` chạy cổng **`4100`** (qua Quick Tunnel `trycloudflare.com` vốn đổi URL mỗi khi restart).
3. **Auth origin phía thư viện/campus mới nhận 1 origin**: `ADMIN_AUTH_ORIGIN` hỗ trợ nhiều origin cách nhau dấu phẩy, nhưng `LIBRARY_AUTH_ORIGIN` và `CAMPUS_AUTH_ORIGIN` trong [auth.config.ts](../../backend/src/modules/auth/auth.config.ts#L44-L55) hiện chỉ nhận **1 origin duy nhất**. Vì vậy mỗi lần URL Preview đổi, login sinh viên/thủ thư dễ gặp `403 FORBIDDEN` cho tới khi chốt cố định về `https://intracampus-l1.vercel.app` (hoặc nâng cấp multi-origin nếu cần chạy cả Preview lẫn Production).
4. **2 luồng chưa nghiệm thu dứt điểm trên chain thật sau khi sửa CORS**:
   - Popup Core chưa mở ở lượt thanh toán bãi xe cũ (khi đó Core còn bị `403` CORS và QR đó đã hết hạn, tab giữ `unknown`).
   - Thư viện sinh viên đang hiển thị màn khôi phục `Nộp cọc · Chưa rõ ví đã gửi hay chưa` của lượt trước, chưa kiểm chứng lượt mượn sách mới.
5. **Escrow thư viện trên cloud manifest chưa redeploy**: [deployments/intracampus-cloud.json](../../deployments/intracampus-cloud.json) vẫn giữ địa chỉ `LibraryDepositEscrow` v1 chưa có `setTreasury`/`setLibrarian`, nên 2 thẻ đổi ví Thư viện trên `/admin` tạm khóa với `ESCROW_UPGRADE_REQUIRED` cho tới khi redeploy riêng contract này.

---

## 2. Chủ dự án cần làm gì? Bạn có cần code thêm không?

### 2.1. Việc chủ dự án (người giữ VM / Vercel / khóa ví) cần làm
1. **Review & Merge PR #41** (`feat/admin-test-console` → `main`) trên GitHub (hoặc cho deploy từ branch này nếu test trước khi merge).
2. **Cấu hình `.env` backend cloud trên GCP VM (`intracampus-demo-vm`, cổng `4100`)** — tuyệt đối không đưa secret vào Git/Vercel:
   - Pull code mới nhất sau PR #41.
   - Bổ sung vào `.env` của service cổng `4100`: `ADMIN_ACCESS_KEY` (dùng đúng key cố định nội bộ của nhóm), `ADMIN_AUTH_ORIGIN`, tùy chọn `ADMIN_DB_PATH` (mặc định tự tạo `admin.sqlite` cạnh `CAMPUS_DB_PATH`).
   - Đặt private key vận hành (nếu muốn `/admin` thực thi giao dịch on-chain thay mặt nhà trường) và đảm bảo các ví đó có đủ `CAMPUS` làm gas:
     - `ADMIN_REGISTRY_SIGNER_PRIVATE_KEY` (khớp `0x4488925B215899128a6eFE9c5efC111675F1acb1`)
     - `ADMIN_LIBRARY_SIGNER_PRIVATE_KEY` (mặc định dùng chung key trên nếu trùng `administrator`)
     - `ADMIN_SBT_ISSUER_PRIVATE_KEY` (khớp `0xC67497dCe89e3373f95aCe1a98b9270e8ab18329`)
     - `ADMIN_GRANT_ISSUER_PRIVATE_KEY` (khớp `0xA1Cb7975324Be2590b3Ae773526fcFcde25f794e`)
     - `ADMIN_FUNDER_PRIVATE_KEY` (nếu dùng nút **Bắn CAMPUS** trên `/admin`)
   - Chuẩn hóa `CAMPUS_AUTH_ORIGIN` và `LIBRARY_AUTH_ORIGIN` thành `https://intracampus-l1.vercel.app` (hoặc URL đích duy nhất đang nghiệm thu).
3. **Trên Vercel Dashboard**:
   - Kết nối Git repository vào project (hoặc deploy commit mới của `main`) với scope **Production** (`https://intracampus-l1.vercel.app`).
   - Chép đủ 4 biến sang scope **Production**: `BACKEND_URL`, `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120`, `NEXT_PUBLIC_INTRACAMPUS_RPC_URL`, `NEXT_PUBLIC_ALLOW_LOCAL_ANVIL=false` (không đặt `ADMIN_*` lên Vercel).
4. **Quyết định có redeploy `LibraryDepositEscrow` hay không**:
   - Nếu Phase 4 cần test nút **đổi ví Treasury & Thủ thư** trên `/admin`, thực hiện bước 4.3 bên dưới trên VM. Nếu chưa cần đổi 2 ví thư viện khi demo, không bắt buộc redeploy (các chức năng Bãi xe, Nhà ăn, SBT, học bổng `FOOD` vẫn chạy ngay).

### 2.2. Có cần code thêm gì không?
- **Để bắt đầu triển khai Phase 4 lên Vercel + GCP VM: KHÔNG cần code thêm.** Toàn bộ tính năng của `/admin`, đồng bộ ví động và đơn giản hóa form học bổng trên `/login` đã xong trong PR #41.
- **Chỉ cần code thêm TRONG Phase 4 ở 2 trường hợp có điều kiện sau:**
  1. *(Tùy chọn hạ tầng auth)*: Nếu đội ngũ muốn **vừa dùng Vercel Production (`https://intracampus-l1.vercel.app`) vừa dùng thêm URL Preview** trên cùng một backend VM `4100`, mới cần mở rộng `LIBRARY_AUTH_ORIGIN` / `CAMPUS_AUTH_ORIGIN` trong [auth.config.ts](../../backend/src/modules/auth/auth.config.ts) và [auth.routes.ts](../../backend/src/modules/auth/auth.routes.ts) hỗ trợ nhiều origin cách nhau dấu phẩy (giống `ADMIN_AUTH_ORIGIN`). Nếu chỉ dùng cố định `https://intracampus-l1.vercel.app` thì không cần sửa.
  2. *(Nếu lỗi cũ tái hiện khi E2E sạch)*: Chỉ sửa [wallet.ts](../../frontend/lib/wallet.ts), [payment.ts](../../frontend/lib/payment.ts) hoặc [LibraryRequests.tsx](../../frontend/app/student/library/LibraryRequests.tsx) **nếu** sau khi fix CORS + tạo hóa đơn POS mới / yêu cầu mượn sách mới trên Production mà popup Core vẫn không bật hoặc bị lỗi giao dịch bất thường.

---

## 3. Kế hoạch thực hiện chi tiết cho chat Phase 4

> **Nguyên tắc cho agent làm Phase 4:** Kiểm tra hiện trạng thực tế (service VM, tunnel URL, CORS, env Vercel) trước khi sửa file. Không đoán URL tunnel hay ghi secret vào Git/chat/log. Tuân thủ [AGENTS.md](../../AGENTS.md).

### Bước 4.1 · Rà soát & cập nhật GCP VM (`intracampus-demo-vm`, `asia-southeast1-b`)
1. Xác nhận process đang chạy cổng `4100` (Phase 3B `20261120`) và cổng `4000` (tránh trỏ nhầm tunnel vào `4000`).
2. Pull code `main` mới nhất (đã gồm PR #41), kiểm tra `pnpm install --frozen-lockfile` nếu cần, đối chiếu `.env` của service `4100`:
   - `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120`
   - `INTRACAMPUS_RPC_URL` trỏ node cloud nội bộ; chạy `pnpm rpc:check` phải ra `ready` & `20261120`.
   - Đủ 4 SQLite paths tách biệt (`INVOICES_DB_PATH`, `LIBRARY_DB_PATH`, `CANTEEN_DB_PATH`, `CAMPUS_DB_PATH`) + `ADMIN_DB_PATH`.
   - `CAMPUS_AUTH_ORIGIN`, `LIBRARY_AUTH_ORIGIN`, `ADMIN_AUTH_ORIGIN` khớp domain Vercel.
   - Chạy `pnpm --filter @intracampus/backend seed:canteen` (an toàn, giữ nguyên đơn cũ) nếu menu nhà ăn chưa đồng bộ.
3. Kiểm tra `infra/rpc-gateway.mjs` (`intracampus-phase3b-rpc.service`): `RPC_ALLOWED_ORIGINS` phải có exact origin của app Production (`https://intracampus-l1.vercel.app`) và Core Extension (`chrome-extension://agoakfejjabomempkjlepdflaleeobhb`). Kiểm tra preflight `OPTIONS` từ cả hai origin trả `204`.
4. Kiểm tra Quick Tunnel hiện tại trỏ vào `4100` (API) và `8787` (RPC gateway). Nếu có hostname cố định / Named Tunnel, ưu tiên dùng để tránh đổi `BACKEND_URL` mỗi lần restart VM.

### Bước 4.2 · Deploy lên Vercel Production & Smoke Check chỉ đọc
1. Đặt biến môi trường ở scope **Production** trên Vercel (`BACKEND_URL`, `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120`, `NEXT_PUBLIC_INTRACAMPUS_RPC_URL`, `NEXT_PUBLIC_ALLOW_LOCAL_ANVIL=false`).
2. Deploy commit `main` mới nhất lên Production `https://intracampus-l1.vercel.app`.
3. Chạy kiểm tra chỉ đọc trước khi giao dịch thật:
   - `GET https://intracampus-l1.vercel.app/api/network` → `status: "ready"`, `chainId: 20261120`.
   - `GET https://intracampus-l1.vercel.app/api/deployment` → `200` (manifest cloud `20261120`).
   - `GET https://intracampus-l1.vercel.app/api/config/runtime` → trả đúng 4 ví hoạt động (`parkingMerchant`, `canteenMerchant`, `libraryTreasury`, `libraryLibrarian`).
   - Mở `/admin` (kiểm tra trang không hiện `AppNav`, mở khóa bằng `ADMIN_ACCESS_KEY` thành công, tab **Signers VM & Nhật ký** báo sẵn sàng & đủ gas).

### Bước 4.3 · (Tùy chọn) Redeploy riêng `LibraryDepositEscrow` trên `20261120`
Chỉ chạy khi muốn bật nút đổi ví Treasury & Thủ thư trên `/admin` cho chain cloud:
1. Build Foundry: `cd contracts && forge build --force`.
2. Nạp env công khai trong shell (dùng ví cloud từ `deployments/intracampus-cloud.json`):
   - `NEXT_PUBLIC_INTRACAMPUS_CHAIN_ID=20261120`
   - `INTRACAMPUS_RPC_URL=<rpc nội bộ trên VM>`
   - `DEPLOYER_ADDRESS=0x4488925B215899128a6eFE9c5efC111675F1acb1`
   - `LIBRARY_ADMIN_ADDRESS=0x4488925B215899128a6eFE9c5efC111675F1acb1` (bắt buộc bằng `DEPLOYER_ADDRESS` theo `DeployLibrary.s.sol`)
   - `LIBRARY_LIBRARIAN_ADDRESS=0xdF3E797ac8A969992D6395B62B347043A2aE0F68`
   - `LIBRARY_TREASURY_ADDRESS=0x83907f9A2685efcbb2BeDa057Cb23a3809c8f750`
   - `LIBRARY_BOOK_IDS` và `LIBRARY_BOOK_REPLACEMENT_PRICES_WEI` khớp `deployments/intracampus-cloud.json`
3. Chạy `forge script script/DeployLibrary.s.sol:DeployLibrary --rpc-url "$INTRACAMPUS_RPC_URL" ... --broadcast --slow` (dùng `--account` keystore Foundry).
4. Xuất manifest cập nhật từ gốc repo:
   ```sh
   node contracts/script/export-library-deployment.mjs \
     --broadcast contracts/broadcast/DeployLibrary.s.sol/20261120/run-latest.json \
     --environment avalanche-l1 \
     --base deployments/intracampus-cloud.json \
     --output deployments/intracampus-cloud.json \
     --replace
   ```
5. Nếu `library.sqlite` trên VM có bản ghi gắn địa chỉ escrow cũ, đánh dấu reset dữ liệu test thư viện (nếu là môi trường test) hoặc đối chiếu lịch sử trước khi restart backend & redeploy Vercel.

### Bước 4.4 · Tái hiện & xử lý dứt điểm 2 hiện tượng từ Phase 3B
1. **Thanh toán bãi xe (`/pos` → `/student` → Core → `/staff/parking`)**:
   - Đảm bảo không còn hóa đơn hết hạn hay journal `unknown` cũ từ lần lỗi trước CORS trên trình duyệt thử nghiệm.
   - Tạo **hóa đơn mới** ở `/pos`, quét/mở trên `/student`, kiểm tra số dư & SBT hiển thị đúng, bấm thanh toán **một lần**, xác nhận popup Core mở, nhận receipt `InvoicePaid` và test cổng ra `/staff/parking/checkout/[invoiceId]`.
   - Nếu popup Core vẫn không bật trong khi CORS/RPC trả 200: bắt log provider error chính xác trong `WalletController` rồi mới sửa code có đích.
2. **Thư viện (`/student/library` → `/staff/library`)**:
   - Trên tài khoản sạch (hoặc sau khi đối chiếu xong request cũ nếu có), tạo **yêu cầu mượn sách mới** → ký `deposit` 50 CAMPUS → đăng nhập ví Thủ thư duyệt `approve` → `confirmPhysicalReturn` → `settleReturn` và kiểm tra số dư hoàn cọc.

### Bước 4.5 · Bộ kiểm tra E2E toàn hệ thống & bàn giao kết quả cuối
Chạy đủ các ca sau trên `https://intracampus-l1.vercel.app` (ghi lại `txHash` thật, block, URL và loại trừ mọi secret):
1. **Onboarding & Học bổng `FOOD`**: Sinh viên ký `/login` → gửi hồ sơ → dùng `/admin` (hoặc `/staff/students`) duyệt SV + cấp SBT (`-10%`) + cấp 20 CAMPUS → sinh viên bấm 1 nút **Gửi đăng ký học bổng** (không dropdown) → `/admin` duyệt & giải ngân học bổng `FOOD` → kiểm tra số dư tại `/student`.
2. **Nhà ăn (`/student/canteen` → `/staff/canteen`)**: Đặt món trả bằng ví hoặc số dư `FOOD` vault → kiểm tra biên nhận và màn hình quầy bếp.
3. **Đổi ví đích trên `/admin`**:
   - Đổi ví nhận `PARKING` (hoặc `FOOD`) sang ví test B → tạo hóa đơn/đơn hàng mới → xác nhận giao dịch đi tới ví mới và ví B đăng nhập được `/staff/parking` nếu là `PARKING`.
   - Nếu đã redeploy Escrow: đổi `treasury` và `librarian` trên `/admin`, xác nhận biên nhận cũ vẫn verified và thủ thư mới đăng nhập được `/staff/library`.
   - Trả lại bộ ví mặc định sau khi test xong (hoặc ghi rõ cấu hình ví đang dùng cho buổi demo).
4. **Cập nhật tài liệu bằng chứng**: Ghi tổng hợp hash giao dịch & kết quả nghiệm thu vào `docs/evidence/` hoặc cập nhật trạng thái trong [2026-11-21-vercel-gcp-core-wallet.md](2026-11-21-vercel-gcp-core-wallet.md) (theo đúng `AGENTS.md`).

---

## 4. Prompt mở đầu để dán sang chat Phase 4 mới

```text
Đọc kỹ AGENTS.md, docs/handoffs/phase4-e2e-and-production.md, docs/handoffs/2026-11-21-vercel-gcp-core-wallet.md, docs/cloud-deployment.md và docs/admin-console.md.
Hiện chúng ta bắt đầu Phase 4 cho IntraCampus L1 trên nhánh đã merge PR #41 (chain cloud 20261120, Vercel Production https://intracampus-l1.vercel.app, VM GCP asia-southeast1-b).
Trước tiên hãy rà soát hiện trạng (VM cổng 4100, Quick Tunnel / domain, CORS, Vercel Production env) và chốt các bước cấu hình cần làm với tôi trước khi sửa bất kỳ code nào. Tuyệt đối không ghi key/token/PII vào Git hay log.
```
