# U04 / U05 · Bàn giao tích hợp

Source bắt đầu từ `main` `f6667b4` (B04 đã merge), đã cập nhật main `4ec299e`
sau khi nhóm merge U04 #18. U05 #19 tiếp tục giữ PR riêng và không tự thay đổi
trạng thái sprint thay reviewer.

| Task | Kết quả | Hướng dẫn |
| --- | --- | --- |
| U04 | Core của sinh viên gửi payInvoice sau preflight mới, giữ intent/hash, khôi phục qua GET và dùng chung receipt POS | [u04-payment.md](u04-payment.md) |
| U05 | Beneficiary ký spend FOOD, số dư/allowlist từ B05 và L06, receipt khớp mới xác nhận; intent chưa rõ khóa gửi tiếp | [u05-grants.md](u05-grants.md) |

## Kết quả kiểm tra

- Node 24.22.2, pnpm 11.25.0: `pnpm typecheck`, `pnpm test`, `pnpm build` đạt
  trên source U04/U05 sau sửa review. Bộ test có 345 pass, 1 skip integration
  B03 tùy chọn; frontend 127 pass, gồm 14 regression mới cho khôi phục không hash.
- Source ghép kiểm thử riêng: main `4ec299e7` + B05 `0abf0d565` + U05 sau sửa:
  **403/403 pass, 0 skip** (backend 204, frontend 127, P02 35, artifact 5,
  exporter 32), typecheck/build và CLI Anvil 8 tình huống đạt. Giữ script/test
  B04/B05 khi xử lý conflict trong worktree kiểm thử.
- `pnpm test:rpc`: 18 pass. Không thay Solidity, genesis hoặc giao kèo P02.
- [Evidence EVM/controller](fixtures/u04-u05-local-evidence.json): 8 tình
  huống chạy contract L03/L04/L05 thật, B01/B02/B05 HTTP và controller frontend
  thật. Hai ví trả 3.000/2.700 đúng payer/calldata; reload, từ chối ký và mất
  phản hồi sau broadcast không gửi lại. Grant 5.000 → chi 1.000 → còn 4.000;
  ví cá nhân, sai category và vượt số dư bị chặn.
- [Báo cáo browser](../artifacts/u04-u05/browser-report.json): Edge headless
  với provider thử nghiệm, Student 390 × 844 và POS 1440 × 1000. Đã chạy QR
  payload → ký giả lập trên ví Anvil → receipt thật, giữ hash khi pending qua
  reload cả hai trang, từ chối ký, replay QR, hai mức giá, chi grant, reload
  không chi lại, sai chain. Không có page error hoặc tràn ngang.
- [Ảnh receipt POS](../artifacts/u04-u05/pos-normal-receipt.png),
  [receipt sinh viên](../artifacts/u04-u05/student-discount-receipt.png),
  [grant sau khi chi](../artifacts/u04-u05/student-grant-after.png) có nhãn
  kiểm thử. Đây là hai viewport trên desktop, chưa phải điện thoại vật lý/Core.
- Review không hash: [6 ca browser mới](../artifacts/u05-recovery/browser-report.json)
  dừng account/chain checks trước gửi, tab cũ giữ Web Lock, reload và khôi phục
  prepared không cần hash/không gửi, chỉ bấm chi mới mới có giao dịch, còn đã
  broadcast nhưng mất phản hồi vẫn bị khóa sau reload. Có
  [ảnh prepared](../artifacts/u05-recovery/prepared-after-reload.png) và
  [unknown vẫn khóa](../artifacts/u05-recovery/unknown-remains-blocked.png).

Browser dùng bản sao source riêng và manifest cấu hình tổng hợp để chạy với
Anvil; canonical `deployments/intracampus.json` của các nhánh vẫn unconfigured.
Nguồn API B05 được ghép với main trong worktree kiểm thử riêng, giữ script/test
của B04. Hash trong evidence chỉ thuộc node Anvil tạm, không phải Avalanche L1.

## Phần nhóm cần ghép và nghiệm thu

1. U04 #18 đã merge vào main; PR U05 #19 dùng main làm base và giữ các test
   U04/B04. Không merge U05 vào nhánh U04.
2. Tích hợp B05 PR #16 và xử lý conflict theo main mới; giữ mọi test script
   trong backend/package.json và cả các quyết định. U05 dùng giao kèo B05,
   chưa chép API/seed từ nhánh đồng đội vào task frontend.
3. Operator xuất manifest L06 L1 thật, bàn giao RPC HTTPS 20261 và seed B03/B05.
   Build/restart hai client từ cùng manifest, SQLite trên volume bền vững.
4. Hai thiết bị HTTPS chạy Core thật, quay QR → xác nhận → receipt cho hai ví;
   tiếp tục voucher 5.000 → 4.000 và đường merchant bị chặn. Lưu hash/event thật.
   Kết quả local và CI không thay mốc nghiệm thu này.

Test EVM/controller có thể tái tạo bằng CLI trong [runbook U05](u05-grants.md).
Không cần gửi khóa/seed phrase vào chat; người giữ ví tự xác nhận trong Core.
