# Hướng dẫn làm việc với IntraCampus L1

Đây là nguồn quy tắc chung cho Codex, Claude Code, Cursor, Gemini và Copilot. Các file hướng dẫn theo công cụ trỏ về đây. Khi sửa frontend, đọc thêm `frontend/AGENTS.md` và tài liệu Next.js cục bộ mà file đó chỉ đến.

## Nhận và bàn giao task

- Đọc [README](README.md), [bảng sprint](https://intracampus-l1-sprint.mphung2532.chatgpt.site) và các file, phụ thuộc, tiêu chí nghiệm thu của task. Nếu chưa có mã, mô tả rõ phạm vi và để nhóm tạo task khi cần. Chỉ đổi trạng thái, nhận người làm hoặc người review khi người dùng giao việc đó.
- Giới hạn diff theo task. Đọc module và kiểm tra working tree trước khi sửa. Giữ các thay đổi có sẵn của đồng đội. Nếu phụ thuộc chưa xong, ghi mã task và điểm nối còn thiếu để người làm hai phần thống nhất.
- Dùng nhánh như `codex/U01-student-shell` cho Codex hoặc `feat/U01-student-shell` cho thành viên. Một PR cho một task. Đặt mã trong ngoặc vuông trong **tiêu đề** PR, ví dụ `[U01] Dựng khung Student và POS`. Task tự tạo dùng cú pháp `[N-1A2B3C4D]`. Đây là cách bảng sprint gắn PR vào task.
- Nhóm dùng PR vào `main`, với CI qua và ít nhất một thành viên khác review. Chuyển task sang *Chờ duyệt* khi gửi PR. Người review xác nhận nghiệm thu rồi mới đánh dấu *Xong*. Trạng thái PR trên bảng chỉ là bằng chứng cho quy trình này.
- Báo kết quả theo mã task, thay đổi, kiểm tra đã chạy và phần còn thiếu. Dùng link PR hoặc hash giao dịch demo khi có. Chỉ push, merge, deploy hoặc cập nhật bảng trong phạm vi người dùng giao. Tránh force push và viết lại lịch sử đã chia sẻ.

## Ranh giới giữa các module

| Nguồn chính | Trách nhiệm |
| --- | --- |
| `packages/network/` | Chain ID, thông tin đồng gốc và kiểu dữ liệu mạng dùng chung |
| `infra/` | Cấu hình L1 và hướng dẫn tái tạo, kiểm tra RPC |
| `contracts/` | Quyền on-chain, kiểm tra chữ ký và hạn hóa đơn, ngăn trả trùng, xác định số tiền cuối, phát sự kiện |
| `backend/` | Tạo hóa đơn POS, chuẩn bị chữ ký merchant và đọc receipt/event theo giao kèo đã thống nhất |
| `frontend/` | Hiển thị hóa đơn và trạng thái, yêu cầu ví của sinh viên ký giao dịch |

Trong backend, đặt route và service theo module nghiệp vụ dưới `backend/src/modules/`. Xem [kiến trúc backend](backend/README.md) để đối chiếu đường dẫn với mã task.

Khi sửa ABI, event, kiểu EIP-712, API công khai hoặc cấu hình chain, đối chiếu các bên gọi và nêu phần ảnh hưởng trong PR. Ghi quyết định dùng chung vào [docs/decisions.md](docs/decisions.md). Dùng lại kiểu và hàm sẵn có. Thống nhất giao kèo trước khi hai module phát triển song song.

## Thanh toán và AI

- Sử dụng số nguyên ở đơn vị nhỏ nhất của `CAMPUS`. Dùng `bigint` trong TypeScript và chuỗi số nguyên khi chuyển qua JSON. Chỉ định dạng khi hiển thị.
- Coi QR, dữ liệu nhập và phản hồi từ RPC là đầu vào cần kiểm tra. Kết quả thanh toán dựa trên receipt thành công và event khớp hóa đơn, địa chỉ hợp đồng và mạng. UI phân biệt giao dịch đang chờ, thất bại và đã xác nhận.
- Dùng dữ liệu và ví demo. Giữ khóa ký, token, `.env` thật và thông tin định danh sinh viên ngoài Git, log, QR và dữ liệu on-chain. Các biến môi trường phía trình duyệt chỉ chứa giá trị công khai. Ghi chú trên bảng sprint dành cho thông tin có thể chia sẻ với người xem bảng. Link PR private được đồng bộ theo mã task.
- Với Copilot trong sản phẩm, phạm vi mặc định là tra cứu từ dữ liệu đã xác minh. Số dư, mức giảm giá và trạng thái lấy từ code hoặc chain. Nếu thiếu dữ liệu thì nêu rõ. Mọi giao dịch đi qua bước hiển thị số tiền, đích nhận, mạng và xác nhận bằng ví của người dùng.

## Kiểm tra

- Web, API và package chung dùng `pnpm typecheck`, `pnpm test`, `pnpm build` theo phần bị ảnh hưởng. Với thay đổi giao diện, mở luồng thực tế cần kiểm tra.
- Solidity dùng `forge fmt --check`, `forge build`, `forge test` trong `contracts/`. Với logic thanh toán, kiểm tra đường thành công và lỗi liên quan như sai chữ ký, hết hạn, trả trùng hoặc sai quyền.
- Phân biệt fixture, EVM local và L1 thật trong báo cáo. Dùng `pnpm rpc:check` để xác minh RPC đúng chain ID trước khi làm việc với L1. Ghi hash hoặc receipt khi tuyên bố đã kiểm tra trên L1.
