# Bản ghi trước · Q02 trên Anvil

Mở [video MP4 của POS](pos-sbt-anvil.mp4), rồi mở riêng
[ảnh biên nhận POS](pos-sbt-receipt.png) và [ảnh biên nhận FOOD](food-student-receipt.png).
Tải cả thư mục về laptop trước buổi demo. Nói “Bản ghi trước từ Anvil local,
ví giả lập” trước khi phát. Clip ghi màn hình POS từ lúc tạo invoice SBT đến
lúc hiển thị biên nhận. Dùng ảnh FOOD để minh họa phần học bổng.

## Bản chạy được ghi

- Source `14b4a6234b3f4a5265204776e1e844b4aa13af0b`, ngày 14/11/2026.
- Chain 20261, Anvil 1.7.1, HTTP loopback, Edge 157 headless, provider EIP-1193
  giả lập. Next build từ source copy để UI nhận manifest test. Cấu hình và
  địa chỉ này thuộc node tạm.
- Registry `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`. Cổng web/API/RPC
  trong lượt ghi chỉ phục vụ máy local. Xem manifest đầy đủ và `InvoicePaid`
  trong [log QR/SBT](../q02-payment/browser-report.json).
- Invoice `0x8a3499d33b047c25990628f6d2f191e37452024c6a5c37bc21477e2189100945`,
  hash `0x48866f2fab08f8ad1bf0242894eeed8f420b60183a6c794389777aa8c05a2d71`,
  số đã trả 2.700 CAMPUS. Clip và ảnh POS dùng cùng receipt.
- FOOD chi 1.000, còn 4.000 CAMPUS, hash
  `0xafa265375fdfd69f95a7b3706f8dcef98e98d69542fd787d698b699a3bfb19d4`.
  `GrantSpent` và vault nằm trong [log FOOD](../q02-food/browser-report.json).

Khi người vận hành báo chuyển sang dự phòng, mở các tệp local. Giữ invoiceId
và hash của giao dịch trực tiếp để tra lại sau khi có kết nối. Bản ghi này
giúp giải thích luồng trong lúc chờ Q04 lưu clip Core/L1 của buổi chạy thật.
