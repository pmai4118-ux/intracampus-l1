# U02 · Ví sinh viên, số dư và SBT

Student View `/student` mặc định mở **Ví thật**. Bản U01 được giữ nguyên ở **Xem bản minh họa**; dữ liệu fixture không đi vào trạng thái ví thật. U02 không ký, không gửi giao dịch, không tạo QR. Nút thanh toán luôn khóa cho tới khi U03/U04 được tích hợp.

## Cấu hình công khai

Tạo `frontend/.env.local` từ `.env.local.example`:

```dotenv
NEXT_PUBLIC_INTRACAMPUS_RPC_URL=
NEXT_PUBLIC_STUDENT_SBT_ADDRESS=
```

L02 bàn giao RPC HTTPS đúng chain `20261`; L06 bàn giao địa chỉ `StudentSBTIdentity` thật của cùng deployment. Khi chưa có, để trống; không lấy địa chỉ từ QR, ví hoặc fixture. Chỉ các giá trị công khai được đặt trong biến `NEXT_PUBLIC_`; tuyệt đối không có private key/API token. HTTP chỉ được chấp nhận cho loopback khi phát triển local. RPC cần cho phép CORS origin của frontend.

Các biến này được Next.js đóng vào bundle ở build time: đổi cấu hình phải khởi động lại dev server hoặc build lại. Địa chỉ SBT phải khác zero. Sai cấu hình không tạo kết quả mặc định tier 0. Khi chỉ thiếu SBT, số dư đọc được vẫn hiển thị, quyền ưu đãi giữ **chưa xác minh**.

PR L06 #12 hiện chưa merge. U02 không nhập loader chưa có trong main, không tạo thêm manifest và không merge PR đó. Khi L06 vào main, người tích hợp đổi nguồn `WalletConfig` sang manifest đã được shared loader xác minh (`contracts.StudentSBTIdentity.address`), giữ RPC công khai từ L02; nếu đồng thời giữ env địa chỉ thì phải kiểm tra nó khớp manifest. Không coi manifest `unconfigured` hay `local-anvil` là deployment Avalanche L1 thật.

## Cách thử bằng hai tài khoản demo

1. Chạy `pnpm install --frozen-lockfile`, `pnpm --filter @intracampus/frontend dev` với Node 24/pnpm 11.25.0. Mở `http://127.0.0.1:3000/student`.
2. Dùng Core/MetaMask có provider EIP-1193 trong trình duyệt desktop, hoặc trình duyệt dApp trong ví trên điện thoại. U02 không có WalletConnect/QR kết nối ví; trình duyệt điện thoại thông thường không có provider sẽ hướng dẫn mở trong ví.
3. Bấm **Kết nối ví**. Với tài khoản có SBT còn hạn, đối chiếu địa chỉ, CAMPUS và tier 1. Chuyển tài khoản demo không có thẻ trong ví: địa chỉ/số dư phải đổi và tier về 0. Nếu ví cấp quyền nhiều tài khoản, có thể chọn trong danh sách.
4. Chuyển ví sang chain khác: số dư/thẻ cũ bị xóa ngay và nút đổi mạng xuất hiện. Thử từ chối rồi chấp nhận chuyển mạng. Nếu ví chưa biết chain, app yêu cầu thêm mạng bằng cấu hình công khai rồi kiểm tra lại `eth_chainId`; thành công từ popup chưa đủ để kết luận.
5. Thử RPC lỗi, bấm **Thử đọc lại**, kiểm tra số dư chưa đọc khác số dư 0. Ngắt phiên app rồi đổi chain không được tự nối lại; bấm kết nối để mở phiên mới. Nút ngắt phiên không thu hồi quyền truy cập đã cấp trong tiện ích ví.
6. Trước khi đối chiếu L1 thật, đặt RPC backend và chạy `pnpm rpc:check` (repo không có lệnh `pnpm rpc`). Ghi bản deploy, địa chỉ ví demo, thời điểm/block và kết quả. Không cần chuyển tiền để nghiệm thu phần đọc ví U02.

## Giao diện tích hợp U04/U06

`WalletSession` tạo một controller cho phiên mount và dọn listener/timer/HTTP abort khi tháo. `useCampusWallet()` cung cấp `{state, controller}`; đặt các component U04/U06 dưới cùng session, không mở controller thứ hai.

- `state.address`, `accounts`, `chainId`: nguồn ví; thay tài khoản/chain xóa dữ liệu xác minh trước khi đọc mới.
- `balanceWei`: `bigint | null`; null nghĩa chưa đọc được, không phải zero. Định dạng bằng `formatWalletBalance`, giữ chính xác tới 1 wei.
- `card`: `tier` chỉ 0/1 sau xác minh; `unknown` giữ null. `credentials` phân biệt thẻ còn trong ví nhưng hết hạn với không có thẻ hiện tại; không có thẻ có thể là chưa cấp hoặc đã thu hồi, U02 không đoán lịch sử.
- `canProceed`: chỉ là điều kiện sẵn sàng đọc ở đúng chain, không phải quyền gửi giao dịch. U04 phải kiểm tra lại tài khoản/chain, invoice/signer/hạn, lấy quote và simulate ngay trước mở ví theo P02. Lỗi/đang tải/sai mạng luôn false. Số dư hiển thị không khẳng định đủ trả một invoice cụ thể.
- U06 chỉ dùng dữ liệu đã xác minh; không dùng số liệu của StudentDemo để trả lời số dư thật.

Số dư, tier và credentials đọc tại cùng block từ RPC tin cậy; thời hạn xét theo timestamp block, không theo đồng hồ điện thoại. Đọc lại khi quay về tab, mỗi 30 giây nếu đang kết nối và khi bấm thử lại. Controller dùng số thế hệ và abort để phản hồi cũ không ghi đè tài khoản/mạng mới. `tierOf` là nguồn quyền ưu đãi, `balanceOf` không được dùng thay thế.

## Kiểm thử tự động và bằng chứng

`pnpm --filter @intracampus/frontend test` chạy unit/controller và HTTP transport. `pnpm test` gốc bao gồm frontend, backend, P02 và regression loader L04. Test dùng ABI ethers ở môi trường dev để kiểm tra selector/đầu vào của decoder; không thêm ethers vào bundle runtime frontend.

Kiểm thử trình duyệt dùng Python Playwright/Chromium riêng, provider được inject và RPC được intercept; không truy cập ví cá nhân. Để tái tạo, khởi động frontend với:

```powershell
$env:NEXT_PUBLIC_INTRACAMPUS_RPC_URL='http://127.0.0.1:18548'
$env:NEXT_PUBLIC_STUDENT_SBT_ADDRESS='0x3333333333333333333333333333333333333333'
pnpm --filter @intracampus/frontend dev
```

Ở terminal khác có Python Playwright đã cài (`python -m pip install playwright`, `python -m playwright install chromium`):

```powershell
python frontend/test/wallet-browser.py
```

Các địa chỉ/URL trên chỉ dùng trong test; không ghi chúng vào cấu hình demo L1. [Báo cáo trình duyệt](../artifacts/u02/browser-report.json), [ví đã kết nối mobile](../artifacts/u02/connected-mobile.png), [sai mạng mobile](../artifacts/u02/wrong-chain-mobile.png), [RPC lỗi](../artifacts/u02/rpc-error-mobile.png), [desktop](../artifacts/u02/connected-desktop.png). Ảnh có nhãn ví/RPC giả lập.

`pnpm rpc:check` trong phiên này trả `not-configured`, expected chain `20261`, exit 1. Chưa có RPC L1, địa chỉ SBT deployment thật và ví tương tác để nghiệm thu. Bằng chứng controller/HTTP/trình duyệt là giả lập, không phải nghiệm thu Avalanche L1 hoặc điện thoại vật lý.

Kiểm tra cuối trên Node 24.22.1/pnpm 11.25.0: `pnpm typecheck`, `pnpm test` (131/131 gồm 42 frontend), `pnpm build`, `git diff --check` đạt. Chromium kiểm tra 13 tình huống ở 390×844 và 1440×1000, không lỗi page và không tràn ngang. [Ảnh production chưa cấu hình](../artifacts/u02/production-unconfigured-mobile.png) xác nhận tier/số dư chưa đọc vẫn null, thanh toán bị khóa. Review độc lập phát hiện một race thông báo từ chối đổi mạng sau ngắt phiên; test tái hiện thất bại trước sửa và đạt sau generation guard. Reviewer xác nhận bản sửa, không còn finding cần xử lý; không thay thế review nghiệm thu của thành viên nhóm.

Nguồn giao tiếp ví: [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193), [Core switch network](https://docs.core.app/docs/reference/wallet_switchethereumchain/), [MetaMask network management](https://docs.metamask.io/metamask-connect/evm/guides/manage-networks/). Tài liệu Next.js cục bộ đã đọc: `use-client.md`, `environment-variables.md`; không đưa biến bí mật qua client boundary.

Skills áp dụng: using-superpowers; brainstorming (đối chiếu phạm vi đã được người dùng chốt); writing-plans; test-driven-development; systematic-debugging; vercel-react-best-practices; webapp-testing; requesting-code-review; receiving-code-review; verification-before-completion. Tài liệu và code trong repo là nguồn giao kèo, không tự đổi sprint/nhận reviewer.
