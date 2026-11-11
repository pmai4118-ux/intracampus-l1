# B03 · Khôi phục ví và SBT demo

Lệnh seed chuẩn bị hai ví thử nghiệm trên IntraCampus `20261`: ví thường không có thẻ và ví sinh viên có SBT tier `1`. Số tiền là **số dư tối thiểu**, không phải khoản chuyển thêm ở mỗi lượt. Mặc định `10.000 CAMPUS` mỗi ví, tương ứng chuỗi `10000000000000000000000` wei; có thể đổi trong cấu hình công khai. Lệnh không tạo hoặc lưu private key của sinh viên.

## Chuẩn bị

1. Cài Node 24 và pnpm theo [README](../README.md), chạy `pnpm install --frozen-lockfile` tại gốc repository.
2. L02 cung cấp RPC đang chạy đúng chain `20261`. L03 phải đã deploy `StudentSBTIdentity`; issuer cần CAMPUS để trả gas. Nếu L06 đã chạy, lấy file deployment thật theo [runbook triển khai](deployment.md). Khi chưa có L06, dùng `--sbt` với địa chỉ SBT thật đã kiểm chứng.
3. Tạo hai ví mới trong ví điện tử cho demo; lưu khóa/seed phrase riêng trên máy. Chỉ sao chép địa chỉ công khai. Không dùng ví đang có thẻ cho vai ví thường. Không dùng địa chỉ funder làm một trong hai ví; issuer cũng nên là ví quản trị riêng.
4. Sao chép `backend/.env.example` thành `backend/.env` (đã bị Git bỏ qua). Điền `INTRACAMPUS_RPC_URL`. Khi áp dụng, điền `SEED_FUNDER_PRIVATE_KEY` và `SEED_ISSUER_PRIVATE_KEY` từ ví funder/issuer demo. Khóa phải có dạng `0x` + 64 ký tự hex. Cả hai có thể trỏ cùng ví nếu ví đó là issuer; không dán khóa vào lệnh terminal, chat hoặc log.
5. Sao chép [cấu hình mẫu](../backend/scripts/demo-accounts.example.json) tới một file riêng, ví dụ `backend/.env.demo-accounts.json` (đã bị Git bỏ qua). Thay ba địa chỉ mẫu bằng địa chỉ demo thật; mẫu không có khóa tương ứng và không được dùng nguyên trạng để gửi tiền. `expiresAt` là **chuỗi Unix giây cố định**, phải lớn hơn thời gian block hiện tại. Chọn hạn đủ dài cho toàn bộ buổi demo. Giữ nguyên hạn khi chạy lại cùng phiên seed.

Các lệnh dưới đây chạy từ gốc repository. `pnpm --filter` đặt thư mục làm việc về `backend`, nên đường dẫn `../deployments/...` tính từ đó:

```sh
pnpm rpc:check
pnpm --filter @intracampus/backend seed:demo --help
pnpm --filter @intracampus/backend seed:demo --accounts .env.demo-accounts.json --deployment ../deployments/intracampus.json
```

Nếu chưa có deployment L06:

```sh
pnpm --filter @intracampus/backend seed:demo --accounts .env.demo-accounts.json --sbt 0xYourVerifiedStudentSBTAddress
```

`--deployment` và `--sbt` loại trừ nhau. Deployment phải là `schemaVersion: 1`, `status: "deployed"`, `chainId: 20261`, có `contracts.StudentSBTIdentity.address` và `abi` đúng giao diện L03. Khi deployment có `runtimeCodeHash`, lệnh đối chiếu code trên RPC trước khi chạy. Chế độ `--sbt` kiểm tra chain, code tồn tại và giao diện nhưng không có code hash chuẩn để đối chiếu; chỉ dùng với địa chỉ đã xác minh từ receipt L03. File `unconfigured` hoặc địa chỉ placeholder không thể dùng để seed.

## Xem kế hoạch rồi áp dụng

Lệnh mặc định chỉ đọc: in `plan`, hai `funding-plan`, `credential-plan`, trạng thái từng ví và `complete` với `mode: "dry-run"`. Kiểm tra chain, địa chỉ, số dư và lượng nạp. Không cần signing key để đọc.

Sau khi xác nhận các địa chỉ và lượng nạp trong kế hoạch:

```sh
pnpm --filter @intracampus/backend seed:demo --accounts .env.demo-accounts.json --deployment ../deployments/intracampus.json --apply
```

Lệnh kiểm tra toàn bộ trạng thái và signer trước lần gửi đầu. Nó kiểm tra chain một lần nữa ngay trước mỗi giao dịch, chỉ chuyển phần thiếu so với số dư mục tiêu, chờ receipt thành công rồi mới đi tiếp, và chỉ mint khi sinh viên chưa từng có thẻ. Không có API mint tùy ý tier: L03 cấp tier `1`; ví thường giữ tier `0`. Kết quả cuối đọc lại số dư, token ID, tier và expiry từ chain; chỉ có `complete` sau khi chúng khớp yêu cầu.

Mỗi giao dịch có một dòng `submitted` chứa hash ngay sau khi RPC chấp nhận và một dòng `confirmed` chứa hash/block sau receipt. Chỉ chia sẻ dòng kế hoạch, địa chỉ demo, hash và kết quả đọc lại; không chia sẻ `.env`, khóa hoặc log debug từ RPC/wallet.

## Chạy lần hai và xử lý gián đoạn

- Chạy lại với cùng cấu hình: ví đã đủ tiền không nhận thêm; SBT hiện có tier `1` với expiry bằng hoặc dài hơn cấu hình được giữ nguyên, không mint lại. Nếu sinh viên đã tiêu tiền demo thì lần seed sau chỉ bù phần thiếu.
- Thẻ sinh viên hết hạn hoặc expiry ngắn hơn yêu cầu: dừng trước lần nạp đầu với `STUDENT_CREDENTIAL_REQUIRES_RESET`. Issuer cần xem lại token ID rồi chủ động `revoke(tokenId)` bằng quy trình quản trị L03, hoặc dùng một ví sinh viên mới; lệnh seed không tự thu hồi thẻ. Thẻ trên ví thường, kể cả đã hết hạn, cũng làm lệnh dừng.
- Một signer có giao dịch đang pending: dừng bằng `SIGNER_HAS_PENDING_TRANSACTIONS`. Không chạy hai tiến trình seed hoặc dùng các ví quản trị đó để gửi giao dịch khác cùng lúc. Tra hash đã in trước khi thử lại; nếu timeout/mất mạng, giao dịch vẫn có thể được xác nhận sau đó.
- Lỗi một bước: các giao dịch **đã xác nhận trước đó vẫn có hiệu lực**. Sau khi kiểm tra receipt/pending, chạy lại cùng cấu hình; lệnh đọc lại số dư/thẻ để tiếp tục, không dựa vào bộ đếm local. Không sửa file để né sai chain hoặc sai issuer.
- `POST_SEED_VERIFICATION_FAILED`: không coi seed đã hoàn tất; kiểm tra RPC, code hợp đồng, trạng thái ví và receipt. Giao dịch từ ví khác đồng thời có thể thay đổi số dư; dừng các thao tác đồng thời trước khi chạy lại.
- Funder/issuer phải đủ tiền chuyển và gas. Script không lấy khóa genesis từ repository, không bật Native Minter và không tạo CAMPUS mới. Funder thiếu tiền có thể khiến phiên seed dừng sau một phần; khôi phục theo receipt như trên.

Seed B03 chỉ cấp CAMPUS và SBT. Cấp `5.000 CAMPUS` trong grant vault thuộc B05; không nhầm số dư ví cá nhân với quyền chi học bổng.

## Bằng chứng nghiệm thu

```sh
pnpm --filter @intracampus/backend typecheck
pnpm --filter @intracampus/backend test
```

Test tự động kiểm tra số nguyên lớn, cấu hình/ABI, chain sai, thẻ sai, signer bị từ chối, receipt lỗi, lỗi CLI không lộ bí mật, khôi phục một phần và hai lần seed. Có thêm integration test tùy chọn chạy bytecode L03 thật trên Anvil; sau khi `forge build`, đặt `ANVIL_BIN` là đường dẫn executable Anvil và `SEED_SBT_ARTIFACT` là đường dẫn tuyệt đối `contracts/out/StudentSBTIdentity.sol/StudentSBTIdentity.json`, rồi chạy backend test. Không đặt hai biến này thì integration test được ghi `SKIP`.

Đây là kiểm thử fixture/EVM local; không phải bằng chứng L1. Trước khi đánh dấu B03 xong, người giữ node cần chạy trên L1 `20261`, lưu hash thật và số dư/tier/expiry đọc lại cho cả hai lần seed. Một máy sạch khác cần làm lại được từ hướng dẫn với ví mới và file công khai đã kiểm tra. Không commit hash local rồi mô tả như giao dịch trên Avalanche L1.
