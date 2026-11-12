# B05 · Bằng chứng kiểm chứng ngày 2026-11-12

Nhánh `codex/B05-demo-grants`, nền L06 `eba14b8`. Bằng chứng được tạo ở bước kiểm chứng local trước khi gửi PR. Kiểm tra GitHub lại trước PR: main vẫn `3b1d136`, L05/L06 chỉ merged vào nhánh phụ thuộc. Nghiệm thu L1 còn thiếu RPC/manifest thật và người giữ ví issuer.

## Kết quả cuối

| Kiểm tra | Kết quả |
| --- | --- |
| Node / pnpm | Node 24.22.1, pnpm 11.25.0 |
| `pnpm typecheck` | Exit 0, backend/frontend |
| `pnpm test` | Exit 0, 252 pass, 0 fail, 1 skip |
| Phân bổ test | Backend 180 pass + 1 skip; P02 35; artifact L04 5; L06 32 |
| Test B05 | 57 pass: 36 reader/HTTP, 16 seed, 3 CLI, 2 app integration |
| `pnpm build` | Exit 0 sau chạy lại với quyền ghi output Windows |
| Diff tracked và file mới | Không lỗi whitespace |
| Harness B05 Anvil | Exit 0, `anvil/v1.7.1`, chain 20261 |
| `pnpm rpc:check` | Exit 1, `not-configured`; không có RPC L1 được cấu hình |

Một test bị skip là integration SBT B03 tùy chọn chưa bật biến môi trường. Test B05 Anvil đã chạy riêng, không bị skip. Build có lần gặp `EPERM` khi tạo thư mục `_not-found` dưới `.next`; chạy lại cùng lệnh với quyền ghi Windows đạt. Không sửa frontend để xử lý lỗi môi trường này.

## Kiểm chứng hành vi

- Fixture/RPC giả lập: HTTP 0 khác unverified/null; chain sai, code/issuer/registry sai, block reset, RPC lỗi, strict event ABI/metadata, receipt revert/khác vault/orphan, cùng block gỡ merchant sau chi, snapshot/receipt khác fork và cleanup provider.
- Seed dùng chữ ký thật trên transaction fixture: dry-run, đúng FOOD/5.000, chạy lại sau chi và mở lại journal, mất phản hồi sau mining, không rõ kết quả qua restart, tranh chấp journal, sai signer, receipt khác số tiền, bất đồng lịch sử và hash public để phục hồi.
- TDD: test mới được chạy thất bại trước implementation. Review độc lập phát hiện RPC index trả rỗng sau khi tiêu hết có thể cấp trùng khi thiếu journal. Hai test tái hiện thất bại trước sửa; reader sau sửa đối chiếu receipt từng block khi index rỗng, đọc thiếu receipt thì dừng. Sửa thêm snapshot phục hồi đọc số dư sau receipt; test đã thất bại trước sửa rồi đạt.
- Anvil: deploy artifact nguồn hiện tại của SBT/registry/vault; dry-run không transaction; seed 5.000, HTTP xác minh `GrantIssued`; sinh viên chi 1.000, HTTP xác minh `GrantSpent`, căn-tin nhận 1.000 và còn 4.000; chạy lại/mở lại journal/CLI apply không gửi thêm.
- Ba giao dịch lỗi được mine thật trên Anvil: bãi xe nhận FOOD, ví ngoài allowlist nhận FOOD, dùng ngân sách FOOD cho PARKING. Trước gửi có staticCall đối chiếu custom error; receipt status 0, số dư vault/grant/merchant không đổi.

[Evidence JSON](../fixtures/b05-local-evidence.json) có hash nguồn chuẩn hóa LF, manifest và receipt/HTTP response công khai. Không chứa private key, raw signed transaction hoặc RPC operator. Các địa chỉ chỉ tồn tại trên node Anvil tạm đã dừng. Chưa có hash hay receipt Avalanche L1 của nhóm.

[Runbook và giao kèo U05](../b05-grants.md) là nguồn hướng dẫn dry-run/apply, cấu hình và xử lý intent chưa rõ. Seed cần journal chung trên một máy issuer; kiểm tra lịch sử vắng có chi phí đọc block/receipt nên dùng cho chuỗi demo ngắn. Đồng đội vẫn cần review/kiểm chứng L1 sau khi L05/L06 được tích hợp vào main.

## Sau giải quyết conflict với main

Đã tích hợp `main` tại `3b1d136` vào riêng nhánh B05. Giữ `InvoiceCreationService` ở tham số thứ ba của `createApp`, thêm `GrantsService` ở tham số thứ tư và dùng chung invoice repository/RPC cho B01/B02. Giữ test frontend U02/U03 và test L06 trong lệnh `pnpm test`. Nhật ký B01/U02 và D014 của main được giữ; quyết định B05 đổi thành D015 để tránh trùng mã.

Test tạo invoice B01 được chạy trước nối lại service và thất bại 503 thay vì 201; sau sửa, cả invoice B01 và grants B05 đạt. Kiểm tra toàn repo sau tích hợp: `pnpm typecheck`, `pnpm test` **322 pass, 0 fail, 1 skip B03**, `pnpm build` đạt. Harness Anvil B05 chạy lại đạt 5.000 → 4.000, không cấp trùng và ba giao dịch sai bị revert; output kiểm chứng bổ sung nằm local `backend/data/b05-conflict-evidence.json` (bị Git bỏ qua). Phần code contract/seed/reader không đổi so với evidence JSON công khai trước đó. Không triển khai hoặc thực hiện giao dịch trên L1.
