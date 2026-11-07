# Kết nối Avalanche L1 của nhóm

| Thông số theo đề cương | Giá trị |
| --- | --- |
| Mạng | IntraCampus L1 |
| EVM chain ID | `20261` (`0x4f25`) |
| Đồng gốc | `CAMPUS`, 18 chữ số thập phân |

Trên máy đang chạy L1, dùng `avalanche blockchain describe <tên-L1>` để lấy URL RPC. Với AvalancheGo local, URL thường có dạng `http://127.0.0.1:9650/ext/bc/<blockchain-id>/rpc`. Phần `<blockchain-id>` do Avalanche cấp, khác với EVM chain ID `20261`. Xem [tài liệu JSON-RPC chính thức](https://build.avax.network/docs/rpcs/other/guides/issuing-api-calls).

1. Sao chép `backend/.env.example` thành `backend/.env` rồi đặt `INTRACAMPUS_RPC_URL` bằng URL thật.
2. Chạy `pnpm rpc:check` tại thư mục gốc. Kết quả `ready` nghĩa là RPC trả về đúng `eth_chainId`; lệnh trả mã lỗi nếu thiếu RPC, sai mạng hoặc không đọc được.
3. Nếu dùng ví trên máy khác hoặc điện thoại, dùng URL RPC HTTPS trỏ đến L1 demo rồi kiểm tra lại từ thiết bị đó. `127.0.0.1` luôn là thiết bị đang gọi.

Khi dùng Foundry, đặt `INTRACAMPUS_RPC_URL` trong môi trường của shell (hoặc trong `contracts/.env`) để alias `intracampus` hoạt động. Từ `contracts/`, có thể đối chiếu bằng `cast chain-id --rpc-url intracampus`. Hợp đồng dùng EVM target `paris` trong bản khởi tạo; đối chiếu cấu hình fork với genesis thật trước khi chọn target mới hoặc deploy.

Repo chưa có genesis của mạng đang chạy hoặc địa chỉ hợp đồng. Khi nhóm xác nhận cấu hình, lưu bản genesis đã rà soát tại `infra/genesis.json` cùng phiên bản AvalancheGo/VM và cách tái tạo. Giữ keystore, khóa validator và cấu hình bí mật ngoài Git.
