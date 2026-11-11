# B03, L05, L06 · Bàn giao

Đã đối chiếu bảng sprint và `main` sau khi merge L04 PR #8
(`06f2877`). Mỗi task có PR riêng. Code và kiểm thử local đã hoàn thành;
nghiệm thu L1 còn cần máy giữ node của hwng.

| Task | Kết quả | Hướng dẫn |
| --- | --- | --- |
| B03 | Seed CAMPUS phần thiếu, cấp SBT tier 1, kiểm tra chain/issuer/receipt; lần hai giữ nguyên thẻ và không gửi thêm giao dịch | [demo-accounts.md](demo-accounts.md) |
| L05 | Vault native có bảo chứng theo beneficiary/category, allowlist L04 trực tiếp, event cấp/chi và rollback khi chuyển lỗi | [l05-grants.md](l05-grants.md) |
| L06 | Script Forge deploy đúng thứ tự; exporter kiểm chứng bytecode/receipt/cấu hình; ABI/manifest và loader chung cho hai client | [deployment.md](deployment.md) |

## Kiểm tra bản bàn giao

Node 24.22.2, pnpm 11.25.0, Foundry 1.7.1, Solidity 0.8.24 / EVM Paris:

- `pnpm typecheck`, `pnpm build`: đạt.
- `pnpm test`: 143 test đạt khi bật test Anvil B03; mặc định CI app có 142
  đạt và 1 skip vì không có artifact/Anvil trong job app.
- `pnpm test:rpc`: 18 test đạt.
- Trong `contracts/`: `forge fmt --check`, `forge build`, `forge test`: đạt,
  69 test, gồm 19 test vault, 5 test deploy và 3 fuzz test × 256 trường hợp.
- `pnpm smoke:l06`: đạt với chính `Deploy.s.sol` và registry L04 thật;
  CI Foundry có cài Anvil và chạy cùng luồng.
- Review độc lập L05, Deploy/loader và exporter: không còn lỗi chặn trong
  phạm vi đã review. Vẫn cần đồng đội nghiệm thu trên L1.

[Evidence local](fixtures/b03-l05-l06-local.json) chứa receipt deploy/configure,
kết quả seed hai lần, receipt cấp/chi grant và sáu trường hợp bị chặn bằng
`eth_call`. Số dư grant `5000 → 4000 CAMPUS`, merchant nhận đúng `1000`.
Trường hợp lỗi có test rollback on-chain bằng Foundry; mô phỏng trong smoke
không phát sinh giao dịch lỗi hoặc gas. Node Anvil tạm đã dừng sau kiểm thử;
địa chỉ trong evidence không phải địa chỉ L1 để cấu hình client.

## Merge và chạy trên máy hwng

PR được xếp để mỗi diff chỉ chứa task tương ứng:

1. [B03 #10](https://github.com/pmai4118-ux/intracampus-l1/pull/10) vào `main`.
2. [L05 #11](https://github.com/pmai4118-ux/intracampus-l1/pull/11) đang dùng
   base B03; sau bước 1, đổi base sang `main` rồi review/merge.
3. PR L06 đang dùng base L05; sau bước 2 đổi base sang `main`.
   L06 còn draft cho đến khi có receipt và cấu hình L1 thật.

Trên máy node: xác minh RPC 20261, chọn ví demo/keystore, chạy mô phỏng và
broadcast theo L06, xuất manifest từ receipt thật, rồi seed theo B03. B05
cấp grant theo ABI L05, không dùng seed SBT để giả định đã có học bổng.
Build/khởi động lại cả hai client và đối chiếu `/api/deployment`.
Giữ khóa trong máy operator; chỉ chia sẻ địa chỉ/hash/manifest công khai.
