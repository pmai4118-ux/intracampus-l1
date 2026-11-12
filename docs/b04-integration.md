# B04 · Ghép POS, invoice và receipt thật

B04 dùng POST B01, GET B02 và manifest L06 chung. U04 sở hữu việc ví Core sinh viên ký/gửi giao dịch; B04 không gửi thanh toán thay sinh viên. Giữ nguyên giao kèo P02 và dùng chuỗi wei trong JSON.

## Nguồn tích hợp

Nhánh B04 bắt đầu từ main `3b1d136`, ghép source L05/L06 từ `05f9c98` (bao gồm `eba14b8`). L05/L06 chưa nằm trên main tại lúc ghép. Khi giải quyết conflict, giữ test frontend, P02, L04 và L06. Không merge hoặc deploy thay nhóm.

Manifest canonical `deployments/intracampus.json` hiện là `unconfigured`; chưa có bằng chứng B04 trên L1. `http://127.0.0.1:3000` là web local, không phải RPC hay đường HTTPS cho hai thiết bị.

## Phạm vi nghiệm thu

1. B01/U02/B02 dùng cùng verifier, SBT, merchant, POS signer, ABI và deployment block từ L06; chặn cấu hình lệch.
2. POS phát hành invoice thật, theo dõi GET và chỉ hiện thành công khi có receipt đã xác minh. Reload khôi phục invoice cũ bằng GET, không POST/pay lại.
3. Backend dùng SQLite trên volume bền vững; receipt đã commit còn đọc được sau restart và khi RPC mất kết nối.
4. Hai thiết bị truy cập Student/POS qua HTTPS cùng origin; lưu payload, tx hash, ảnh receipt và log lỗi đã loại secret.

## Trạng thái bằng chứng

Đang triển khai. Chỉ cập nhật kết quả sau khi chạy kiểm tra; fixture/Anvil không phải bằng chứng Avalanche L1.

## Cấu hình canonical

Khi manifest đã deploy lên L1, backend lấy registry/block, merchant bãi xe, signer công khai và SBT từ manifest. Biến `PARKING_MERCHANT_ADDRESS` hoặc registry/block nếu còn đặt phải khớp. Trước phát hành, khóa POS phải đúng role signer; registry phải trả cùng signer/SBT và bật merchant/category PARKING tại cùng block. Khóa vẫn chỉ nằm trong `POS_SIGNER_PRIVATE_KEY` phía backend.

U02/U03 lấy SBT, verifier và signer từ cùng manifest; `NEXT_PUBLIC_*` địa chỉ nếu còn đặt phải khớp. RPC công khai vẫn lấy từ môi trường và được kiểm tra chain 20261. Manifest unconfigured chỉ giữ đường cấu hình thủ công phục vụ phát triển/fixture, không xác nhận deployment L1.

## Điểm nối POS / U04

`frontend/lib/invoice-status.ts` cung cấp `InvoiceStatusController` và `parseInvoiceLookup`. POS dùng `watch(invoiceId, envelope?, txHash?)`, `refresh(txHash?)`, `restore()` và `dispose()`. U04 có thể dùng controller hoặc gọi GET hiện có với `?txHash=...` sau khi chính ví sinh viên gửi. Backend cũng tìm event theo invoiceId, vì vậy hai thiết bị không cần chia sẻ state trình duyệt để POS thấy thanh toán.

POS chỉ gửi POST khi người vận hành bấm tạo. Nó poll GET tuần tự khoảng 2 giây, dùng Retry-After khi 503, backoff 2/4/8/16/30 giây khi mất kết nối. `pending`, `expired`, `rpc-error`, `reverted`, `event-mismatch` không tạo thông báo thành công. Dừng poll khi paid; vẫn tra cứu invoice hết hạn để nhận receipt đến muộn. Có form nhập invoiceId/txHash để đối chiếu thủ công.

Trình duyệt giữ invoiceId và hash chưa có kết luận (kể cả request chưa được backend xác nhận); reload GET lại invoice đó. Chỉ receipt hợp lệ có khóa `(chainId, contractAddress, txHash, logIndex)` mới tạo thông báo lần đầu; đọc lại cùng receipt không thông báo lại. Storage bị chặn thì UI nêu rõ cần giữ invoiceId/hash để phục hồi thủ công. U04 vẫn cần lưu hash phía Student và làm mới preflight trước khi mở Core; `InvoiceStatus.tsx` của B04 không chiếm file `Receipt.tsx` đề xuất cho U04.
