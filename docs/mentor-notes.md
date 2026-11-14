# Q02 · Ghi chú nghiệm thu và phương án dự phòng

Ngày 14/11/2026, nhánh `codex/Q02-demo-acceptance` dựa trên `main` `14b4a62`.
Đã chuẩn bị [checklist hai thiết bị](demo-checklist.md) và chạy lại các bài kiểm
tra local từ source này. Demo trực tiếp với Core còn chờ môi trường và lượt
chạy độc lập. Thông tin công khai không đủ để suy ra deployment đang hoạt động.

| Môi trường | Bằng chứng có thể trình bày | Giới hạn |
| --- | --- | --- |
| Test dự án/fixture | `pnpm typecheck`, `pnpm test` 412 đạt, `pnpm test:rpc` 18 đạt, `pnpm build` | Kiểm tra source, gồm fixture và test Anvil B03 tùy chọn được bật. |
| Anvil 20261 | [Controller/API](evidence/q02-controller.json), [Student/POS](evidence/q02-payment/browser-report.json), [FOOD](evidence/q02-food/browser-report.json) | Node tạm, receipt thật trong EVM local, ví EIP-1193 giả lập. Một số ca lỗi dùng ngắt request/HTTP 503 ở trình duyệt. Hai viewport trên cùng máy. |
| Avalanche L1 / Core | CHƯA CHẠY. RPC local báo `not-configured`. | Cần manifest đang chạy và người giữ ví trên thiết bị thật. |
| Bản ghi trước | [Bộ offline Q02](evidence/q02-offline/README.md), [bằng chứng mở file](evidence/q02-offline/offline-verification.json) | Video/ảnh Anvil local đã mở trong Edge ở chế độ offline. Còn lượt tắt mạng trên laptop trình diễn. |

Điểm có thể trình bày từ lượt local là ví thường trả 3.000 CAMPUS, ví SBT trả
2.700 CAMPUS, Student/POS cùng nhận receipt đã xác minh, và FOOD 5.000 →
4.000 CAMPUS sau chi 1.000. Hash/receipt, phiên bản trình duyệt và deployment
nằm trong JSON. Trình duyệt ghi 2 giao dịch thanh toán và 3 khoản chi trong
các kịch bản FOOD. Khi dựng bài kiểm tra, các lượt đầu phát hiện lỗi của
harness: ngắt RPC trước khi ví sẵn sàng, selector chưa đúng phần tử và body
503 thiếu `invoiceId`. Đã đối chiếu với DOM và giao kèo P02 để sửa bài kiểm
tra. `test:rpc` ban đầu chạy Bash mặc định không thấy Node; chạy lại với Git
Bash và Node 24 đạt 18/18. Code nghiệp vụ giữ nguyên trong Q02.

## Việc chặn nghiệm thu

L02 [PR #5](https://github.com/pmai4118-ux/intracampus-l1/pull/5) và L06
[PR #12](https://github.com/pmai4118-ux/intracampus-l1/pull/12) đã merge phần
mã/runbook. Bàn giao trong repo chưa ghi endpoint HTTPS đang chạy hoặc receipt
deploy thật. Manifest `main` là `unconfigured`. Bản code đã merge vẫn cần
đối chiếu deployment thực tế trước demo.

| Việc | Ảnh hưởng và cách xử lý | Người đã nhận | Mốc đề xuất |
| --- | --- | --- | --- |
| Bộ cấu hình bản demo L1 | Operator cung cấp APP_URL, RPC HTTPS chính/phụ, manifest với địa chỉ/hash công khai và bản deploy. Chạy rpc:check và đối chiếu hai `/api/deployment`. | Chưa xác nhận. Cần người giữ node L02 và người phụ trách L06. | Trước lượt độc lập, trước mốc Q02 21/11 |
| Ví và số dư demo | Người giữ ví chuẩn bị B03/B05 theo runbook, ghi allocation thực tế. Dùng ví đã seed và đủ gas cho lượt quay. | Chưa xác nhận. Operator/ví issuer và sinh viên demo. | Trước lượt Core |
| Laptop/điện thoại/Core và mạng dự phòng | Thử camera, dán chéo thiết bị, Wi-Fi/hotspot và quy trình giữ hash khi mất RPC. Chọn người báo chuyển và người mở video. | Chưa xác nhận. Người vận hành POS, giữ ví và ghi kết quả. | Trước 21/11 |
| Nghiệm thu độc lập | Một thành viên khác tự chạy theo checklist, ghi từng ca, hash và bằng chứng hai thiết bị, ký xác nhận kết quả của họ. | Chưa có lượt độc lập. | Mốc Q02 21/11 |
| Bản ghi trước của lượt L1 | Khi buổi Core có receipt khớp, quay lưu MP4, ảnh receipt, ghi chú deploy. Thử mở đầy đủ khi hai thiết bị mất mạng. | Chưa xác nhận. Bàn giao người nhận Q04. | Sau lượt L1, trước buổi demo |

## Bàn giao Q04 và Q05

- **Q04** dùng bước QR-01–06 và FOOD-01–03 trong checklist để quay liền mạch
  giữa hai thiết bị. Bản ghi Anvil hiện có là phương án minh họa tạm thời. Khi
  có clip L1, giữ manifest, cùng invoiceId/hash, và nhãn môi trường. Thử mở
  bộ mới khi tắt mạng trên chính laptop trình diễn.
- **Q05** lấy số phí và độ trễ từ [Q01 #20](https://github.com/pmai4118-ux/intracampus-l1/pull/20)
  theo từng môi trường. Bảng L1 chờ phép đo trên bản deploy thực tế. Bằng
  chứng Q02 chốt trạng thái nghiệp vụ, màn hình và cách chuyển dự phòng,
  không dùng để suy ra p95 hay thông lượng.
- **Nội dung ngoài nghiệm thu Q02.** Copilot B06/U06 đã dừng. Tab Mượn sách
  trên [bản animation](https://intracampus-l1-flow.bracedduet8.chatgpt.site/?flow=library)
  minh họa proposal, nghiệp vụ thư viện thuộc chuỗi task riêng.
