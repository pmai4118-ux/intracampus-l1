# MVP module Thư viện có đặt cọc CAMPUS

**Trạng thái:** Thiết kế được người dùng duyệt ngày 2026-11-14; chờ nhóm xác nhận thông số demo và triển khai theo task riêng. Đây là hướng thay thế Copilot trong đề xuất ban đầu; không triển khai Copilot trong phạm vi này.

## Mục tiêu và phạm vi

Tạo catalog seed để sinh viên tra cứu sách, xem bản còn, gửi yêu cầu mượn, nộp cọc CAMPUS và trả sách qua thủ thư. Dùng SQLite quan hệ cho dữ liệu nghiệp vụ và escrow contract riêng trên chain IntraCampus 20261.

Bao gồm luồng sinh viên, giao diện/thao tác thủ thư, xác thực demo, lưu trữ, audit và đối soát DB với chain. Không gồm quản lý catalog bằng giao diện, Copilot/LLM/API AI, IdP thật, hoặc khóa dịch vụ của trường ngoài demo IntraCampus. Hold chỉ chặn chức năng thường trong ứng dụng demo; vẫn cho phép mở luồng trả sách và thanh toán cần thiết để gỡ hold.

## Quyết định đã duyệt

- Cọc bằng native CAMPUS trên chain 20261, escrow contract riêng. Sinh viên ký bằng ví của mình; backend không giữ tiền hoặc private key.
- Catalog và bản sách lưu trong SQLite, dữ liệu ban đầu seed cho demo. Không có CRUD quản lý catalog.
- Deposit cố định 50 CAMPUS cho mỗi bản sách trong MVP (18 chữ số thập phân, 50 CAMPUS = 50 × 10^18 wei; mức tương ứng 50.000 VND là quy ước demo). Giá thay thế bằng giá sách trong catalog. SQLite lưu các giá trị; escrow seed book ID, cọc và giá sách trước khi mở mượn rồi seal, không có CRUD/đổi terms on-chain trong UI.
- Cho phép thủ thư giữ/khấu trừ cọc theo quy chế bên dưới.
- Quy trình duyệt yêu cầu hết hạn sau 24 giờ kể từ khi khoản cọc được xác nhận. Không giữ bản sách trong lúc người dùng chưa nộp cọc.
- Thời hạn mượn 14 ngày; ân hạn 3 ngày; phạt trễ 0,1 CAMPUS cho mỗi đủ 24 giờ sau ân hạn, tối đa 50% tiền cọc (25 CAMPUS). Với mốc giữ toàn bộ cọc sau 30 ngày, trần 50% là giới hạn phòng vệ nhưng không đạt được trong vòng đời khoản mượn hiện tại.
- Các mức thời hạn/ân hạn/phí là policy cố định của phiên bản contract demo. Deposit 50 CAMPUS và giá sách được đọc từ book terms đã seal; contract tự kiểm tra đúng tiền cọc khi nhận deposit và snapshot giá sách vào loan khi duyệt. Thủ thư không được truyền giá khác lúc duyệt; backend đối chiếu terms on-chain với seed SQLite.
- Nếu sách được trả không muộn hơn 30 ngày sau hạn, trừ khoản phạt đã phát sinh và hoàn phần cọc còn lại. Với sách không hỏng, đúng 30 ngày phí tối đa là 2,7 CAMPUS (27 kỳ đủ 24 giờ sau ân hạn) và hoàn 47,3 CAMPUS. Nếu có sửa chữa, khấu trừ sửa chữa cũng được áp dụng; tổng khấu trừ không vượt 50 CAMPUS. Quá 30 ngày thì giữ toàn bộ cọc khi thủ thư xác nhận trả.
- Quá 30 ngày sau hạn, khóa chức năng thường trong demo IntraCampus. Gỡ hold khi thủ thư xác nhận đã nhận lại sách và quyết toán được xác nhận on-chain; hoặc khi mất sách đã được quyết toán và khoản thiếu đã thanh toán.
- Nếu mất sách, khoản tất toán là giá sách trừ tiền cọc đã giữ; chỉ thu thêm phần còn thiếu. Nếu giá sách thấp hơn cọc, hoàn phần dư. Không cộng phí trễ riêng vào khoản tất toán mất sách.
- Nếu hỏng sách, thủ thư ghi nhận chi phí sửa và trừ tối đa tiền cọc. Tổng khoản giữ/khấu trừ từ cọc không vượt tiền cọc.
- Khoản khấu trừ chuyển tới ví quỹ thư viện cấu hình cho escrow. Chưa cần địa chỉ để hoàn thiện plan/code; trước khi deploy 20261 nhóm gắn địa chỉ quỹ. Khi setup local EVM có thể tạo ví test mới cho demo; private key chỉ lưu trong secret local/gitignored, không trong repo/backend hay log. Ví L1 nếu cần cũng được tạo offline và chỉ public address đưa vào cấu hình contract.

## Danh tính và quyền

MVP dùng allowlist tài khoản demo phía server, gồm wallet address và role STUDENT hoặc LIBRARIAN. Đăng nhập bằng challenge có nonce dùng một lần được ký từ ví; backend xác minh chữ ký rồi tạo session cookie bảo mật. Role chỉ lấy từ allowlist server, không nhận role do client gửi.

Sinh viên chỉ tạo/xem yêu cầu và khoản mượn của mình, gửi giao dịch cọc, yêu cầu trả, và claim refund đã đến hạn. Thủ thư ký giao dịch duyệt/từ chối, xác nhận đã nhận/kiểm tra sách và lập quyết toán mất/hỏng. Cùng ví thủ thư phải được cấp role tương ứng trong escrow contract. Không có màn hình quản lý tài khoản/role; seed cấu hình demo.

## Quy trình nghiệp vụ và escrow

### Yêu cầu, cọc và quyết định

1. Deployer seed book ID, deposit 50 CAMPUS và giá sách vào escrow trước demo rồi khóa cấu hình. Backend xác nhận mapping on-chain trùng với SQLite trước khi cho phép tạo yêu cầu.
2. Khi người dùng chọn sách, backend kiểm tra hold, tạo request ID và intent chứa borrower, book ID và deposit dự kiến. Chưa gán/khóa bản sách; intent không được xem là lượt mượn.
3. Frontend yêu cầu ví sinh viên nộp vào escrow theo request ID và book ID. Contract chống dùng lại request ID, lấy deposit từ book terms đã seal, yêu cầu msg.value khớp tuyệt đối và ghi ví nộp/số tiền.
4. Chỉ sau receipt thành công và event khớp chain 20261, contract, request ID, ví, book ID và số cọc, backend mở transaction SQLite BEGIN IMMEDIATE để tìm và gán một bản sách còn AVAILABLE. Nếu tìm được, chuyển request sang PENDING_APPROVAL; thời điểm event bắt đầu cửa sổ duyệt 24 giờ. Nếu hết sách do race, không mượn bản nào; đánh dấu REJECTED_NO_COPY và REFUND_DUE để thủ thư reject/refund hoặc người mượn claim refund khi hết hạn. Bản sách chỉ được gán cho tối đa một request.
5. Thủ thư ký approve hoặc reject bằng ví có quyền. Contract chỉ cho approve khi block.timestamp < approvalDeadline; tại deadline hoặc sau đó, approve revert. Khi approve, contract dùng terms đã seal cùng policy cố định, chuyển sách sang ON_LOAN và đặt hạn trả 14 ngày theo timestamp giao dịch duyệt. Backend đối chiếu event với terms on-chain và seed SQLite. Reject hoàn cọc về đúng ví gốc.
6. Reject chỉ giải phóng bản đã gán sau receipt/event reject thành công. Tại/sau deadline, contract không thể approve; backend đánh dấu request EXPIRED_REFUND_DUE và giải phóng bản ngay khi xác minh chain time, không chờ người mượn claim refund. Refund hết hạn permissionless, luôn về ví gốc; UI chỉ báo đã hoàn sau receipt/event xác nhận.

### Trả, phạt, hold và quyết toán

- Sinh viên gửi yêu cầu trả; thủ thư xác nhận đã nhận vật lý và tình trạng sách. Contract ghi nhận thời điểm xác nhận trả và tính mức quyết toán từ các điều khoản đã khóa trong loan.
- Trả trong ngưỡng 30 ngày sau hạn: phạt trễ theo quy tắc; nếu đạt trần 50%, phần 50% còn lại vẫn hoàn. Trả quá ngưỡng: giữ cả cọc. Bản sách chỉ thành AVAILABLE sau khi receipt quyết toán được xác minh; nếu cần sửa, đặt MAINTENANCE.
- Guard dùng chung kiểm tra nợ quá hạn đồng bộ trước mỗi API nghiệp vụ campus đã xác thực trong demo, bằng latest block timestamp lấy từ RPC tin cậy. Mỗi lần kiểm tra xác nhận chain ID 20261 và đối chiếu timestamp với ngưỡng tuổi/độ lệch tương lai lấy từ cấu hình deployment. Ngưỡng phải được nhóm xác lập từ mẫu block timestamp 20261 và độ lệch đồng hồ backend khi setup; không có giá trị mặc định. Nếu chưa cấu hình, RPC lỗi, sai chain hoặc timestamp stale/future ngoài ngưỡng, API nghiệp vụ thường trả 503 retryable (fail closed), không dùng timestamp cache cũ. Health/network/login và UI trả/settlement/claim vẫn có thể mở; thao tác cần xác minh chain chờ RPC phục hồi. Nếu now > dueAt + 30 ngày và chưa trả, ghi hold idempotent theo loan rồi chặn request. Đúng ngưỡng 30 ngày chưa khóa; một giây sau thì khóa. Guard áp dụng cho route sinh viên như invoice/grants/library. Worker đối soát là bổ sung, không thay guard trước request. UI hiển thị lý do và đường gỡ hold.
- Sách mất: thủ thư ghi nhận mất; khoản phải trả bằng max(giá sách - cọc, 0), cọc đã giữ là khoản cấn trước; nếu cọc lớn hơn giá thì hoàn phần dư. Không cộng phạt trễ riêng sau khi lập quyết toán mất. Hold chỉ được gỡ sau khi receipt quyết toán/hoàn phần dư hoặc receipt trả khoản thiếu đã xác nhận. Không nhận tiền ngoài chain trong MVP.
- Sách hỏng: thủ thư ghi reason và chi phí sửa; khoản khấu trừ được giới hạn bởi tiền cọc và hợp đồng chống quyết toán lặp. Khi có phí trễ, tổng tiền giữ từ cọc vẫn không vượt tiền cọc.

### Trạng thái chính

- Bản sách: AVAILABLE → PENDING_APPROVAL → ON_LOAN → RETURN_REVIEW → AVAILABLE hoặc MAINTENANCE; PENDING_APPROVAL → AVAILABLE khi reject đã xác nhận hoặc chain time đạt deadline. Không đổi trạng thái khi chỉ tạo intent hay gửi tx chưa xác minh.
- Request: AWAITING_DEPOSIT → PENDING_APPROVAL → APPROVED, REJECTED hoặc EXPIRED; nếu receipt hợp lệ nhưng không còn bản thì REJECTED_NO_COPY. Tại deadline (inclusive) request EXPIRED và không thể approve; trạng thái refund vẫn tách riêng đến receipt xác nhận.
- Loan: ACTIVE → RETURNED → SETTLED; quá 30 ngày có hold; mất sách có thể ở REPLACEMENT_DUE đến khi thanh toán thiếu được xác minh.

## Mô hình dữ liệu SQLite

Đặt module tại backend/src/modules/library/; DB mặc định là backend/data/library.sqlite, cho phép cấu hình LIBRARY_DB_PATH. Dùng migration có phiên bản, bật foreign keys, WAL, synchronous FULL, busy timeout và sao lưu SQLite nhất quán. Việc gán bản sách và cập nhật request/kho liên quan dùng cùng transaction.

| Bảng | Dữ liệu cốt lõi |
| --- | --- |
| accounts | account ID, wallet duy nhất, role demo, trạng thái |
| books | ISBN tùy chọn, nhan đề/tác giả, book price wei, deposit wei cố định 50 CAMPUS, seed version |
| book_copies | book ID, mã bản/barcode duy nhất, trạng thái |
| borrow_requests | request/account/book ID, copy ID nullable đến khi gán sau receipt, trạng thái, số cọc, approval deadline, chain/contract, tx tham chiếu |
| loans | request duy nhất, snapshot deposit/replacement/policy, approved/due/returned timestamps, trạng thái |
| chain_events | chain ID, contract, tx hash, log index duy nhất, block number/hash, event và payload đã kiểm tra |
| settlements | loan duy nhất, loại/reason, số giữ/hoàn/thiếu, thủ thư, tx tham chiếu |
| account_holds | account, loan nguồn, loại hold, thời điểm bắt đầu/gỡ |
| audit_log | actor/role, hành động, target, reason và timestamp |

Số CAMPUS lưu bằng chuỗi số nguyên wei, không dùng floating point/SQLite REAL. Không lưu tên hay mã sinh viên thật trong fixture; ví trên chain là dữ liệu công khai nên chỉ dùng ví demo. Giữ lịch sử mượn, event tham chiếu và audit log trong môi trường demo; không log nonce, chữ ký, khóa hoặc bí mật.

SQLite phù hợp một backend instance cho MVP. Nếu chạy nhiều replica hoặc cần HA, chuyển module sang PostgreSQL trước khi scale; không dùng SQLite file chia sẻ như giải pháp multi-writer.

## Ranh giới DB và chain

- SQLite là nguồn dữ liệu catalog, bản sách, danh tính demo, request/loan, hold và audit.
- Escrow là nguồn sự thật cho terms tài chính đã seal, trạng thái tiền, recipient, approve/reject/expire, settlement và refund.
- API không đánh dấu một giao dịch hoàn tất từ tx hash do client gửi. Xác minh receipt thành công trên đúng chain, contract tin cậy và event có request/loan ID, ví, số tiền, trạng thái phù hợp.
- Ghi event theo khóa duy nhất (chainId, contractAddress, txHash, logIndex). Lưu block number/hash để đối soát; xử lý event lặp idempotent.
- Lệnh/worker đối soát các request đang chờ receipt và giao dịch bị ngắt giữa chain/DB sau restart. Chỉ cập nhật projection từ receipt/event đã xác minh; không tự gửi transaction thay ví người dùng.
- UI phân biệt PENDING, FAILED, REFUND_DUE và đã xác nhận. Backend trả chuỗi wei; UI định dạng CAMPUS.

## Chia lát triển khai

1. **Giao kèo và chính sách:** dùng policy đã chốt: khi mất sách, tổng quyết toán bằng giá sách; cấn 50 CAMPUS trước và không cộng riêng phí trễ. Chốt ABI/event/error cho request ID, sealed book terms, deposit, approve/reject, expire/refund, return/settle, lost-book shortfall; thêm quyết định ABI/event/API và caller impact vào docs/decisions.md trước khi backend/frontend phát triển. Seed/seal book terms trước khi mở mượn. Contract bảo đảm một lần quyết toán, refund về ví gốc và giới hạn chi trả; backend thực thi hold theo policy đã duyệt.
2. **Backend và DB:** migrations/repository, seed catalog/account, challenge auth, role guard, giữ bản nguyên tử, kiểm chứng receipt/event, xử lý trạng thái, hold, settlement và đối soát.
3. **Student UI:** catalog đọc, chi tiết/tồn kho, ký cọc, request/loan status, lịch sử, yêu cầu trả và claim refund.
4. **Librarian UI:** hàng đợi duyệt 24 giờ, approve/reject, xác nhận sách đã nhận, ghi nhận tình trạng và quyết toán mất/hỏng.
5. **Tích hợp demo:** catalog fixture, ví student/librarian/treasury demo, local EVM 20261, kịch bản đủ success/error/restart. Không tuyên bố đã nghiệm thu trên L1 nếu chưa có receipt thật.

## Tiêu chí nghiệm thu

- Chữ ký challenge hợp lệ từ ví allowlist tạo session; chữ ký sai, ví ngoài allowlist, nonce hết hạn hoặc replay không tạo session. Sinh viên không gọi được thao tác thủ thư; client không thể tự gán role; tài khoản chỉ xem dữ liệu của chính mình.
- Hai giao dịch cọc đồng thời cho bản cuối cùng: SQLite chỉ gán bản đó cho một request; request còn lại thành REJECTED_NO_COPY và tiền chỉ được báo hoàn sau receipt refund. Intent chưa thanh toán không khóa tồn kho.
- Contract revert khi deposit sai book terms/deposit hoặc request đã dùng; mismatch on-chain/SQLite chặn tạo yêu cầu. Sai chain, contract, request ID, ví, số cọc, receipt lỗi hoặc receipt chưa có không kích hoạt request/loan.
- Cọc được xác nhận và có bản sách mới bắt đầu 24 giờ duyệt. Approve chỉ hợp lệ khi block.timestamp < approvalDeadline; tại deadline approve revert và refund permissionless hợp lệ. Kiểm tra deadline-1s, đúng deadline và deadline+1s. Rejection chỉ giải phóng bản sau event xác nhận; expiry giải phóng bản tại/sau deadline dù refund chưa claim. No-copy được hoàn qua reject của thủ thư hoặc claim hết hạn.
- Kiểm tra mốc hạn trả, ân hạn 3 ngày, mỗi đủ 24 giờ, đúng 30 ngày và quá 30 ngày. Với cọc 50 CAMPUS/fee 0,1, sách không hỏng trả đúng ngày 30 bị trừ 2,7 và hoàn 47,3; nếu thêm 10 CAMPUS tiền sửa thì hoàn 37,3. Tổng khấu trừ trong cả hai trường hợp không vượt cọc. Một giây sau ngưỡng, khi thủ thư xác nhận trả, giữ đủ 50 CAMPUS. Trần 25 CAMPUS là defensive cap và không được mô tả như ca có thể đạt trước ngày 30.
- Quá 30 ngày, hold chặn chức năng thường của demo nhưng không chặn luồng trả/chi trả. Hold được gỡ đúng sau receipt xác nhận trả/settle hoặc trả đủ khoản thiếu của sách mất.
- Sách mất kiểm tra giá sách nhỏ hơn, bằng và lớn hơn 50 CAMPUS; tất toán đúng bằng giá sách trừ cọc đã giữ, hoàn dư hoặc yêu cầu giao dịch cho phần thiếu, không cộng phí trễ riêng. Sách hỏng kiểm tra khấu trừ sửa chữa riêng và kết hợp với phí trễ; tổng deductions không thể vượt cọc, phần còn lại được hoàn.
- Không thể approve/reject/refund/settle hai lần. Replay event không tạo loan/hold/refund trùng.
- Restart backend giữ nguyên lịch sử; đối soát khôi phục request khi app dừng giữa lúc gửi tx và nhận event.
- Hợp đồng: test local EVM cho book terms match/mismatch và sealing, quyền, timeout duyệt 24 giờ ở deadline-1/equal/+1, release copy khi reject/expire không phụ thuộc claim, phí 2,7 CAMPUS đúng ngày 30, full deposit sau ngưỡng, refund, settlement và lỗi chuyển tiền. Backend: test guard ngay trên request đầu tiên sau khi app idle qua ngưỡng 30 ngày; sai chain, RPC timeout, thiếu ngưỡng freshness đã cấu hình và timestamp stale/future ngoài ngưỡng đều phải fail closed trên API thường, không dùng timestamp cũ. Khi có RPC 20261, kiểm tra các mẫu khỏe trong ngưỡng cho phép và mẫu stale/future ngoài ngưỡng. API/web: typecheck, test, build; UI mở luồng thực tế. Báo rõ fixture/local EVM/L1.

## Cần chuẩn bị trước demo/deploy

- Chọn danh sách sách seed và giá sách; mức cọc thống nhất 50 CAMPUS mỗi bản.
- Treasury chưa có hiện tại. Với local EVM, setup tạo ví test mới; trước deploy 20261 nhóm cấu hình public address của ví quỹ, còn private key nằm ngoài repo/backend. Cấu hình ví trước deploy để contract nhận đúng recipient.
- Cấp ví demo cho sinh viên/thủ thư/quỹ và deployer để seed allowlist/contract role.
- Chọn confirmation policy RPC cho 20261 và ghi mẫu latest-block timestamp/độ lệch giờ để xác lập ngưỡng freshness/future skew. Cho đến khi có mẫu và cấu hình ngưỡng, API nghiệp vụ thường phải fail closed; chỉ nghiệm thu local EVM, không tuyên bố sẵn sàng L1.
- Nhóm tạo/nhận các task thư viện tương ứng trên bảng sprint trước khi phân người làm. Không nhận hoặc đổi trạng thái task Copilot/B06 trong plan này.

## Nhật ký quyết định

| Ngày | Quyết định |
| --- | --- |
| 2026-11-13 | Dừng Copilot/API AI trong hướng triển khai hiện tại. |
| 2026-11-13 | Chọn native CAMPUS trên chain 20261 và escrow contract riêng; sinh viên ký bằng ví; cho phép giữ/khấu trừ cọc theo quy chế. |
| 2026-11-14 | Chọn SQLite quan hệ cộng escrow on-chain; catalog seed và tương tác mượn/trả/thủ thư, không có catalog CRUD. |
| 2026-11-14 | Chốt timeout duyệt 24 giờ; chỉ demo IntraCampus, không khóa dịch vụ thật của trường. |
| 2026-11-14 | Chốt hold quá 30 ngày, trần phạt 50% trước/ngày 30, full deposit khi trả sau ngưỡng; cấn cọc trước vào giá sách mất và chỉ thu phần thiếu. |
| 2026-11-14 | Chốt đề xuất dùng 14 ngày, 3 ngày ân hạn, 0,1 CAMPUS/mỗi đủ 24 giờ, sửa sách trừ tối đa cọc; không giữ bản trước khi xác nhận receipt cọc. |
| 2026-11-14 | Cọc thống nhất 50 CAMPUS mỗi bản (quy ước demo 50.000 VND); giá thay thế bằng giá sách. Mất sách: tổng tất toán bằng giá sách trừ cọc, hoàn dư nếu có, không cộng phí trễ riêng sau khi khai báo mất. Treasury được cấu hình trước deploy; ví test local có thể tạo lúc setup. |
| 2026-11-14 | Người dùng giữ mức 0,1 CAMPUS/ngày. Với cọc 50 và cutoff 30 ngày, phí tối đa trước cutoff là 2,7 CAMPUS; cap 25 CAMPUS không thể đạt trong vòng đời này. |
