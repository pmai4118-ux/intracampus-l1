# IntraCampus L1

Dự án UniHack 2026 cho thanh toán và định danh trong khuôn viên trường. IntraCampus dùng Avalanche L1 với chain ID `20261`, đồng gốc `CAMPUS` dùng cho gas và thanh toán thử nghiệm. Luồng demo ưu tiên: POS tạo hóa đơn QR → sinh viên xem số tiền và ký → hợp đồng áp dụng ưu đãi theo thẻ SBT → POS nhận biên nhận.

| Thư mục | Vai trò |
| --- | --- |
| `frontend/` | Next.js App Router + TypeScript; trang sinh viên, POS và trạng thái mạng |
| [`backend/`](backend/README.md) | Express + TypeScript, một ứng dụng chia theo module nghiệp vụ. API nền cho POS và lệnh kiểm tra JSON-RPC |
| `contracts/` | Foundry + Solidity; cấu hình compiler, alias RPC và test kiểm tra môi trường |
| `packages/network/` | Cấu hình chain và kiểu phản hồi API dùng chung |
| `infra/` | Hướng dẫn nối L1 của nhóm và xác minh chain ID |

Monorepo dùng pnpm workspace để cả nhóm chia sẻ cấu hình và chạy CI từ một chỗ. Dự án dùng Next.js 16 (App Router). Source hiện có hợp đồng SBT/thanh toán CAMPUS, backend tạo hóa đơn EIP-712 và lưu/đọc receipt, seed ví demo, cùng kết nối ví Core để đọc số dư và thẻ. U03 bổ sung POS phát hành QR thật và Student kiểm tra hóa đơn/giá trước bước thanh toán; việc sinh viên ký `payInvoice` vẫn phải đi qua ví Core trong U04.

## Chạy trên máy

Cài Node.js 24 và pnpm 11.25.0. Có thể cài pnpm bằng `npm install -g pnpm@11.25.0`. Tại thư mục gốc của repo:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

- Web: <http://127.0.0.1:3000> (`/student` và `/pos`).
- API: <http://127.0.0.1:4000/healthz> và <http://127.0.0.1:4000/api/network>.

Web và API khởi động được khi chưa có L1. Để kiểm tra L1 thật, lấy RPC của IntraCampus từ nhóm, đặt chain ID `20261` và đồng gốc `CAMPUS`, rồi chạy `pnpm rpc:check`. Không dùng RPC Fuji C-Chain `43113` cho cấu hình dự án. Xem [hướng dẫn L1](infra/README.md) và [quyết định về mạng/ví](docs/decisions.md#d014--giữ-intracampus-l1-và-tách-quyền-ký-theo-người-khởi-tạo) trước khi cấu hình.

Để tạo hóa đơn, backend cần cấu hình signer POS server-side theo `backend/.env.example`; khóa đó chỉ ký payload hóa đơn ngoài chain. Bản xem trước Student cần RPC, verifier và POS signer công khai đồng bộ với manifest L06; không lấy verifier tin cậy từ QR. Thanh toán do sinh viên khởi tạo phải được ví Core của sinh viên ký. `frontend/.env.local.example` chứa RPC/SBT/verifier/signer công khai và `BACKEND_URL` server-side cho Next.js proxy `/api/invoices`. Builder Hub chỉ cần khi tạo L1 hoặc lấy Data API key, không cần cho việc chạy ứng dụng với L1 đã có.

Hướng dẫn chi tiết cài môi trường, điền `.env`, kiểm tra RPC và chạy luồng U03 trên Windows nằm ở [docs/run-local.md](docs/run-local.md).

B04 nối POS với GET receipt B02: tự theo dõi trạng thái, giữ invoiceId/hash qua reload và hiển thị biên nhận đã xác minh. [Bàn giao B04](docs/b04-integration.md) ghi cấu hình manifest chung, volume SQLite, đường HTTPS hai thiết bị, bằng chứng local và các bước nghiệm thu L1 còn thiếu.

## Kiểm tra trước khi mở PR

```sh
pnpm typecheck
pnpm test
pnpm build
```

Với hợp đồng, [cài Foundry](https://getfoundry.sh/introduction/installation/) và dùng `foundryup --install v1.7.1` (Windows: Git Bash hoặc WSL). Chạy từ thư mục gốc:

```sh
cd contracts
forge fmt --check
forge build
forge test
```

P02 có thêm `pnpm test:p02` (đã nằm trong `pnpm test`) để kiểm tra giao kèo JSON/QR, chữ ký và các tình huống tham chiếu. Foundry kiểm tra cùng [fixture P02](docs/fixtures/invoice-v1.json) bằng Solidity; xem [giao kèo invoice](docs/invoice-contract.md#6-fixture-chạy-được-và-kiểm-tra-giao-kèo). Đây là test fixture/local, chưa phải kết quả L1.

L04 có [hướng dẫn contract thanh toán và bàn giao tích hợp](docs/l04-payment.md), log Foundry và hai receipt Anvil local. Smoke script kiểm tra ABI thực tế theo P02 và luồng thanh toán thường/ưu đãi; địa chỉ triển khai Avalanche L1 thuộc L06.

U04 có [hướng dẫn thanh toán bằng ví sinh viên và khôi phục giao dịch](docs/u04-payment.md), dùng lại QR U03 và receipt B02/B04. Nghiệm thu ví Core trên L1 cần manifest/RPC thật và hai thiết bị HTTPS.

B03/L05/L06 có [bàn giao và kết quả kiểm thử](docs/b03-l05-l06-handoff.md),
[seed ví/thẻ](docs/demo-accounts.md), [vault học bổng](docs/l05-grants.md) và
[deploy/xuất ABI](docs/deployment.md). Manifest L1 hiện chưa cấu hình; bằng chứng
đi kèm là EVM local. Dùng `pnpm smoke:l06` sau `forge build --force` để tái hiện
deploy → seed hai lần → chi học bổng trên Anvil.

GitHub Actions chạy cùng các kiểm tra trên `main` và pull request. Xem [bảng sprint của nhóm](https://intracampus-l1-sprint.mphung2532.chatgpt.site) để chọn task và đọc tiêu chí nghiệm thu. Đặt mã task trong tiêu đề PR, ví dụ `[U01] Dựng khung Student và POS`. Thành viên đã đăng ký trên bảng sẽ thấy PR trong chi tiết task.

Khi giao việc cho AI, nêu mã task, phạm vi file và tiêu chí nghiệm thu, ví dụ “Làm U01 theo AGENTS.md, giới hạn ở frontend và chạy build”. Quy tắc làm việc và lệnh kiểm tra nằm trong [AGENTS.md](AGENTS.md).

## Việc triển khai tiếp theo

Xem [phạm vi MVP và cách làm luân phiên của nhóm](docs/scope.md) cùng [kịch bản demo hai thiết bị](docs/demo-flow.md). Đây là bản đề xuất P01 chờ cả nhóm review; các tính năng và số liệu demo trong tài liệu chưa phải kết quả đã triển khai.

1. Lấy RPC từ L1 đang chạy của nhóm, xác minh `20261` và kiểm tra ví demo nhận CAMPUS.
2. Xem [giao kèo hóa đơn EIP-712 và QR](docs/invoice-contract.md) cùng [giao kèo HTTP API và mã lỗi](docs/api-contract.md) (P02) để triển khai song song `L04`, `B01`, `B02` và `U03`. Sau đó làm luồng tạo QR → ký → biên nhận trước khi thêm voucher.

Tham khảo: [Avalanche Starter Kit](https://github.com/ava-labs/avalanche-starter-kit) cho Foundry và cách nối RPC Avalanche L1; [Vercel App Router Playground](https://github.com/vercel/next-app-router-playground) cho tổ chức giao diện theo route; [chính sách hỗ trợ Next.js](https://nextjs.org/support-policy) cho lựa chọn phiên bản.
