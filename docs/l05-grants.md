# L05 · Học bổng giới hạn merchant và danh mục

`PurposeBoundGrantVault` giữ CAMPUS native trong vault. Issuer cấp ngân sách cho từng cặp `(beneficiary, category)` bằng `grant(address,bytes32)` với `msg.value` đúng khoản cấp. Beneficiary dùng `spend(address merchant,bytes32 category,uint256 amount)` để trả merchant từ ngân sách của chính mình. Toàn bộ số tiền là số nguyên wei, `1 CAMPUS = 10^18 wei`.

Constructor là `PurposeBoundGrantVault(address issuer_, address registry_)`. `issuer()` và `merchantRegistry()` cố định; đổi vai trò hoặc registry cần deploy bản mới tại L06. Issuer chọn người nhận học bổng. Hợp đồng không tự ngừng học bổng khi SBT hết hạn: SBT kiểm soát ưu đãi invoice L04, còn ngân sách học bổng là quyền cấp riêng của issuer.

## Allowlist và cách khóa mục đích

Vault đọc đúng getter `CampusPaymentRegistry.allowedMerchantCategories(address,bytes32)` của L04 mỗi lần chi. Registry admin là người thay allowlist qua `setMerchantCategory`; vault không giữ bản sao có thể lệch trạng thái. Tắt cặp merchant/danh mục có hiệu lực ngay với các grant đã cấp.

Ngân sách tách theo danh mục ngay khi issuer cấp. Ví dụ `FOOD = keccak256(bytes("FOOD"))`: grant FOOD không thể dùng cho bãi xe được allowlist ở PARKING; đổi category khi gọi `spend` không chuyển ngân sách FOOD sang PARKING. Merchant căn-tin phải được cho phép chính xác ở FOOD trước khi chi. Chuỗi category là nhãn cấu hình công khai phải trùng giữa issuer, L06, B05 và U05; contract nhận `bytes32`, không tự suy ra từ tên merchant.

Ví không có trong allowlist, merchant sai danh mục, merchant bị gỡ, địa chỉ zero, vault hoặc chính người chi đều bị từ chối. Registry admin vẫn là vai trò tin cậy có quyền cho phép một merchant mới; contract không thể tự xác định chủ sở hữu thực tế của các địa chỉ khác nhau. Không có hàm rút về ví cá nhân, chuyển ngân sách giữa beneficiary hoặc issuer rút khoản đã cấp.

## ABI và event bàn giao B05/U05/L06

| Hàm | Quyền / kết quả |
| --- | --- |
| `grant(address beneficiary, bytes32 category) payable` | Chỉ issuer; cấp thêm đúng `msg.value`, phải lớn hơn 0 |
| `spend(address merchant, bytes32 category, uint256 amount)` | Trừ ngân sách `msg.sender` và trả CAMPUS trực tiếp cho merchant |
| `balances(address beneficiary, bytes32 category) → uint256` | Ngân sách chưa chi của cặp người nhận/danh mục |
| `totalAllocated() → uint256` | Tổng ngân sách chưa chi; có CAMPUS bảo chứng trong vault |
| `issuer() → address` | Ví cấp học bổng |
| `merchantRegistry() → address` | Registry L04 giữ allowlist |

```solidity
event GrantIssued(
    address indexed beneficiary,
    bytes32 indexed category,
    address indexed issuer,
    uint256 amount,
    uint256 balance
);
event GrantSpent(
    address indexed beneficiary,
    address indexed merchant,
    bytes32 indexed category,
    uint256 amount,
    uint256 balance
);
```

`balance` trong event là số dư của đúng beneficiary/category sau thao tác; không phải số dư ví cá nhân. Backend cần kiểm tra đúng chain `20261`, địa chỉ vault của L06, receipt thành công và event khớp beneficiary/merchant/category/amount trước khi báo đã chi. `GrantSpent` không phải `InvoicePaid`: không có chữ ký POS, invoiceId hay giảm giá SBT. B05/U05 cần dùng đúng ABI này và tự hiển thị gas trả từ ví cá nhân.

Lỗi có thể xử lý theo selector: `UnauthorizedIssuer`, `InvalidBeneficiary`, `InvalidCategory`, `InvalidAmount`, `InvalidMerchant(address,bytes32)`, `InsufficientGrantBalance(uint256 available,uint256 requested)`, `MerchantTransferFailed(address,uint256)`, `ReentrantGrant`, `InvalidConfiguration`. Registry không đọc được thì giao dịch revert, không tự dùng allowlist cũ. Không có `receive`/fallback nhận tiền trực tiếp; cấp ngân sách qua `grant` để tiền luôn đi cùng người nhận và mục đích. CAMPUS ép gửi vào contract ngoài hàm cấp không tự tăng ngân sách.

## An toàn chuyển tiền

Vault giảm ngân sách và `totalAllocated` trước external call tới merchant, chặn reentrancy trong cả cấp và chi. Merchant từ chối nhận tiền làm hoàn nguyên toàn bộ giao dịch, bao gồm ngân sách và CAMPUS. Các lần chi bị từ chối giữ nguyên số dư vault/người nhận/merchant; giao dịch thật bị revert vẫn có thể tốn gas ở ví người gửi.

Kịch bản demo: issuer cấp `5000000000000000000000` wei FOOD cho sinh viên, sinh viên chi `1000000000000000000000` cho căn-tin được allowlist, còn `4000000000000000000000`. Thử PERSONAL hoặc PARKING không được phép ở FOOD phải revert và không giảm ngân sách. L06/B05 lưu địa chỉ/hash thật, không dùng địa chỉ trong test làm bản triển khai.

## Chạy kiểm thử

Từ thư mục `contracts/`:

```sh
forge fmt --check
forge build
forge test
forge test --match-contract PurposeBoundGrantVaultTest -vv
```

Test dùng registry stub triển khai đúng getter L04 để nhánh L05 có thể build độc lập trên `main` khi L04 chưa merge. Bộ test kiểm tra quyền cấp, category, allowlist bị gỡ, ví cá nhân, tự nhận, vượt số dư, chuyển thất bại, reentrancy, event, tách ngân sách và fuzz bảo toàn số tiền. Khi ghép L06 phải kiểm tra thêm bằng registry L04 thật. Đây là bằng chứng Foundry/EVM local; chưa xác nhận triển khai hoặc receipt trên Avalanche L1 của nhóm.
