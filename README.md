# IntraCampus L1

Dự án UniHack 2026 cho thanh toán và định danh trong khuôn viên trường. IntraCampus dùng Avalanche L1 với chain ID `20261`, đồng gốc `CAMPUS` dùng cho gas và thanh toán thử nghiệm. Luồng demo ưu tiên: POS tạo hóa đơn QR → sinh viên xem số tiền và ký → hợp đồng áp dụng ưu đãi theo thẻ SBT → POS nhận biên nhận.

| Thư mục | Vai trò |
| --- | --- |
| `frontend/` | Next.js App Router + TypeScript; trang sinh viên, POS và trạng thái mạng |
| [`backend/`](backend/README.md) | Express + TypeScript, một ứng dụng chia theo module nghiệp vụ. API nền cho POS và lệnh kiểm tra JSON-RPC |
| `contracts/` | Foundry + Solidity; cấu hình compiler, alias RPC và test kiểm tra môi trường |
| `packages/network/` | Cấu hình chain và kiểu phản hồi API dùng chung |
| `infra/` | Hướng dẫn nối L1 của nhóm và xác minh chain ID |

Monorepo dùng pnpm workspace để cả nhóm chia sẻ cấu hình và chạy CI từ một chỗ. Dự án dùng Next.js 16 (App Router) thay cho Next.js 14 trong đề cương để bắt đầu trên dòng còn được hỗ trợ. Bản khởi tạo có ba trang và kiểm tra RPC; ví, thanh toán, SBT và voucher chưa được triển khai.

## Chạy trên máy

Cài Node.js 24 và pnpm 11.25.0. Có thể cài pnpm bằng `npm install -g pnpm@11.25.0`. Tại thư mục gốc của repo:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

- Web: <http://127.0.0.1:3000> (`/student` và `/pos`).
- API: <http://127.0.0.1:4000/healthz> và <http://127.0.0.1:4000/api/network>.

Web và API khởi động được khi chưa có L1. Để kiểm tra L1 thật, tạo `backend/.env` từ `backend/.env.example`, điền RPC rồi chạy `pnpm rpc:check`. Đọc [hướng dẫn L1](infra/README.md) trước khi lấy endpoint từ nhóm. `frontend/.env.local.example` chỉ cần dùng khi địa chỉ API khác mặc định.

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

GitHub Actions chạy cùng các kiểm tra trên `main` và pull request. Xem [bảng sprint của nhóm](https://intracampus-l1-sprint.mphung2532.chatgpt.site) để chọn task và đọc tiêu chí nghiệm thu. Đặt mã task trong tiêu đề PR, ví dụ `[U01] Dựng khung Student và POS`. Thành viên đã đăng ký trên bảng sẽ thấy PR trong chi tiết task.

Khi giao việc cho AI, nêu mã task, phạm vi file và tiêu chí nghiệm thu, ví dụ “Làm U01 theo AGENTS.md, giới hạn ở frontend và chạy build”. Quy tắc làm việc và lệnh kiểm tra nằm trong [AGENTS.md](AGENTS.md).

## Việc triển khai tiếp theo

Xem [phạm vi MVP và cách làm luân phiên của nhóm](docs/scope.md) cùng [kịch bản demo hai thiết bị](docs/demo-flow.md). Đây là bản đề xuất P01 chờ cả nhóm review; các tính năng và số liệu demo trong tài liệu chưa phải kết quả đã triển khai.

1. Lấy RPC từ L1 đang chạy của nhóm, xác minh `20261` và kiểm tra ví demo nhận CAMPUS.
2. Chốt dữ liệu hóa đơn EIP-712 và biên nhận giữa ba phần: POS API, Solidity và web. Sau đó làm luồng tạo QR → ký → biên nhận trước khi thêm voucher.

Tham khảo: [Avalanche Starter Kit](https://github.com/ava-labs/avalanche-starter-kit) cho Foundry và cách nối RPC Avalanche L1; [Vercel App Router Playground](https://github.com/vercel/next-app-router-playground) cho tổ chức giao diện theo route; [chính sách hỗ trợ Next.js](https://nextjs.org/support-policy) cho lựa chọn phiên bản.
