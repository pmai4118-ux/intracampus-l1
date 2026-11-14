# L06 · Deploy và bộ ABI dùng chung

`deployments/intracampus.json` là nguồn công khai duy nhất cho ABI, địa chỉ,
chain ID và receipt deploy. File trong Git hiện có `status: unconfigured`:
chưa có endpoint/receipt Avalanche L1 để điền địa chỉ thật. Không dùng địa chỉ
fixture hoặc địa chỉ Anvil thay cho địa chỉ L1. Các ABI được xuất từ build
Solidity 0.8.24 hiện tại; `abiVersion: 1` phân biệt với schema của manifest.

`@intracampus/network` xuất `getDeployment`, `requireDeployment` và
`deploymentResponse`. Express và Next.js cùng dùng loader này cho
`GET /api/deployment`, `Cache-Control: no-store`. Chưa cấu hình, sai chain,
metadata thiếu hoặc manifest `local-anvil` thì endpoint trả 503
`DEPLOYMENT_NOT_READY`. Bộ dữ liệu đã kiểm chứng trên L1 mới trả 200.
Module thanh toán sau này dùng `requireDeployment()` lấy verifier/ABI; không
lấy địa chỉ tin cậy từ QR. B01/B02/U03/U04 vẫn phải kiểm tra RPC, mô phỏng và
receipt theo P02. L06 không tự bật luồng thanh toán của các task đó.

## 1. Chuẩn bị máy giữ node

L1 của hwng và HTTPS theo [L02](../infra/rpc.md) phải đang hoạt động, trả chain
`20261` (`0x4f25`). Dùng Node 24, pnpm 11.25.0, Foundry 1.7.1:

```sh
pnpm install --frozen-lockfile
pnpm rpc:check
cd contracts
forge fmt --check
forge build --force
forge test
```

`pnpm rpc:check` đọc `backend/.env`. Shell chạy Forge/export cần có riêng
`INTRACAMPUS_RPC_URL` trỏ tới cùng blockchain. Không ghi URL có token vào
manifest hoặc log chia sẻ. Tất cả số tiền là native CAMPUS, 18 decimals;
không có ERC-20 mint/approve.

Chọn các địa chỉ công khai trong [config mẫu](../deployments/deploy.env.example),
thay ví minh họa bằng ví demo thật rồi nạp biến vào shell. Script không tự
đọc file mẫu. `DEPLOYER_ADDRESS` là admin registry; hai issuer có thể là cùng
operator, POS signer ký EIP-712, hai merchant phải khác nhau và khác các ví
quản trị/ký. Giữ một ví sinh viên thường và một ví SBT riêng theo
[B03](demo-accounts.md). Cấp gas cho deployer và issuer trước khi chạy.

Lưu signer deployer trong keystore Foundry cục bộ, ví dụ account alias
`intracampus-deployer`. Import khóa bằng giao diện nhập tương tác của
`cast wallet import`, không đưa khóa vào command line, file công khai hay chat.
L06 chỉ đọc địa chỉ qua biến môi trường; Forge quản lý signer bên ngoài.

## 2. Mô phỏng rồi broadcast

Chạy trong `contracts/`, shell Bash trên máy node (PowerShell dùng `$env:...`
để truy cập biến thay vì `$...`):

```sh
forge script script/Deploy.s.sol:Deploy --rpc-url "$INTRACAMPUS_RPC_URL" --account intracampus-deployer --sender "$DEPLOYER_ADDRESS"
forge script script/Deploy.s.sol:Deploy --rpc-url "$INTRACAMPUS_RPC_URL" --account intracampus-deployer --sender "$DEPLOYER_ADDRESS" --broadcast --slow
```

`Deploy.run` từ chối chain khác **trước broadcast**, kiểm tra toàn bộ địa chỉ,
triển khai `StudentSBTIdentity → CampusPaymentRegistry → PurposeBoundGrantVault`,
sau đó admin cho phép đúng hai cặp:

- Bãi xe: `keccak256("PARKING")`.
- Căn-tin: `keccak256("FOOD")`.

Vault dùng allowlist trực tiếp của registry và ngân sách theo danh mục L05.
Issuer, POS signer, địa chỉ SBT/registry đều được đọc lại sau deploy. Triển khai
không tự cấp SBT hoặc ngân sách grant: B03 và B05 làm các bước đó.

Broadcast gồm nhiều transaction, không nguyên tử cả script. Nếu mất RPC hoặc
một transaction lỗi, lưu lại hash và kiểm tra receipt/nonce trước khi tiếp tục.
Không chạy lại `run` mù quáng vì sẽ tạo bộ contract mới. Forge `--resume` chỉ
dùng sau khi kiểm tra đúng file broadcast, sender, chain và các giao dịch đã
xác nhận. Export từ chối bản deploy chưa hoàn chỉnh. Thay issuer/admin/signer
immutable cần deploy phiên bản mới và cập nhật hai client cùng lúc.

## 3. Xuất và kiểm chứng manifest

Từ **gốc repo**, sau khi tất cả transaction xác nhận:

```sh
node contracts/script/export-deployment.mjs --broadcast contracts/broadcast/Deploy.s.sol/20261/run-latest.json --environment avalanche-l1 --output deployments/intracampus.json
pnpm typecheck
pnpm test
pnpm build
```

Exporter đọc RPC độc lập, đối chiếu chain, receipt, code, artifact/source,
constructor và cấu hình tại một block được ghim ở `verifiedAt`. File chứa ABI đầy đủ của cả ba contract,
địa chỉ, hash/block deploy, hash runtime code, role và hai merchant. Không
chứa RPC URL hoặc signer secrets. Chỉ chia sẻ manifest qua PR sau khi rà soát;
không đưa toàn bộ thư mục broadcast chứa raw transaction vào Git.

Hai client bundle cùng JSON, vì vậy **build và khởi động lại cả backend và
frontend** sau khi cập nhật deployment. Đối chiếu hai URL `/api/deployment`
và `posSigner()` trên đúng chain, rồi dùng B03 cấp ví/thẻ. B02 lấy
`contracts.CampusPaymentRegistry.blockNumber` làm mốc bắt đầu quét event,
verifier và ABI cũng được đọc trực tiếp từ cùng manifest khi đã cấu hình.
Nếu còn đặt `CAMPUS_PAYMENT_REGISTRY_ADDRESS` / `CAMPUS_PAYMENT_DEPLOYMENT_BLOCK`
trong backend thì chúng phải khớp manifest; giá trị khác làm backend từ chối
khởi động. Có thể bỏ hai biến này sau khi đã xuất deployment thật.
Nhóm lưu receipt L1 tương ứng và reviewer chạy lại các bước đọc cấu hình
trước khi đánh dấu L06 hoàn tất trên bảng.

## 4. Kiểm thử local và tái tạo ABI

Sau `forge build` trong `contracts/`, từ gốc:

```sh
pnpm test:l06
pnpm smoke:l06
```

Smoke tự mở Anvil loopback chain 20261, chạy chính Forge script bằng tài khoản
local unlocked, xuất manifest tạm có `environment: local-anvil`, seed ví/thẻ
hai lần rồi kiểm tra grant `5.000 → chi 1.000 → còn 4.000 CAMPUS`. Kiểm tra
ví ngoài allowlist, sai danh mục, vượt số dư và merchant bị tắt đều không làm
mất ngân sách. Smoke không ghi đè manifest L1 hoặc dùng khóa thật. Evidence
mặc định nằm trong temp; có thể truyền đường dẫn output cho script smoke.
Đặt `ANVIL_BIN`, `FORGE_BIN` nếu binary chưa có trong PATH.

Muốn tái tạo ABI khi chưa deploy, dùng chế độ template của exporter từ build
hiện tại:

```sh
node contracts/script/export-deployment.mjs --template --output deployments/intracampus.json
```

Exporter từ chối ghi đè một manifest `deployed`; chỉ dùng `--replace` sau khi
đã kiểm tra việc thay bản triển khai. Nếu bytecode nhúng trong script và artifact
lệch metadata do build cache cũ, chạy `forge build --force` trước mô phỏng/broadcast,
không bỏ qua kiểm tra bytecode. Không thay file `deployed` bằng template trong một bản phát hành
đang dùng. Test artifact cũ, sai chain/receipt/cấu hình phải fail closed.

Nghiệm thu thực tế còn cần RPC công khai đang hoạt động và operator ký trên
máy hwng. Test Foundry/Anvil ở đây không xác nhận Avalanche L1 đã deploy.

## 5. Triển khai và xuất evidence cho `LibraryDepositEscrow`

Module thư viện dùng script và exporter tách riêng với L06 để không tự ý thay
đổi `deployments/intracampus.json` khi triển khai thử hoặc chạy cục bộ. Hiện tại
**chưa thực hiện deploy lên Avalanche L1**; mọi chạy thử Anvil chỉ tạo bằng
chứng `environment: "local-anvil"`.

### Biến môi trường và script Foundry

`contracts/script/DeployLibrary.s.sol` định nghĩa hai entry point:

- `DeployLibrary`: đọc `DEPLOYER_ADDRESS`, `LIBRARY_ADMIN_ADDRESS`,
  `LIBRARY_LIBRARIAN_ADDRESS`, `LIBRARY_TREASURY_ADDRESS` (khác địa chỉ 0 và
  khác ba role trên), `LIBRARY_BOOK_IDS` (chuỗi `bytes32` cách nhau bằng dấu
  phẩy) và `LIBRARY_BOOK_REPLACEMENT_PRICES_WEI` (chuỗi `uint256` đơn vị wei,
  cách nhau bằng dấu phẩy, khớp số lượng ID). Script từ chối `block.chainid != 20261`
  trước broadcast, deploy `LibraryDepositEscrow`, gọi cặp `seedBookTerms` (với
  `DEPOSIT_WEI = 50 ether`) rồi `sealBookTerms` cho từng sách bằng `LIBRARY_ADMIN_ADDRESS`,
  và đọc kiểm tra lại toàn bộ role, hằng số policy cùng `bookTerms(bookId)`.
- `SeedLibraryBooks`: đọc `LIBRARY_ESCROW_ADDRESS`, `LIBRARY_ADMIN_ADDRESS`,
  `LIBRARY_BOOK_IDS`, `LIBRARY_BOOK_REPLACEMENT_PRICES_WEI`. Nếu sách đã niêm
  phong (`sealed`) và khớp điều khoản thì bỏ qua không phát giao dịch; nếu lệch
  điều khoản đã niêm phong sẽ revert `SealedBookTermsMismatch`.

Ví dụ mô phỏng rồi broadcast trên Anvil local (`chainId = 20261`) trong `contracts/`
với keystore/tài khoản riêng biệt (không đưa private key vào CLI hay manifest):

```sh
forge script script/DeployLibrary.s.sol:DeployLibrary --rpc-url "$INTRACAMPUS_RPC_URL" --account library-deployer --sender "$DEPLOYER_ADDRESS"
forge script script/DeployLibrary.s.sol:DeployLibrary --rpc-url "$INTRACAMPUS_RPC_URL" --account library-deployer --sender "$DEPLOYER_ADDRESS" --broadcast --slow
```

Luôn truyền `--slow` cùng `--broadcast` để từng giao dịch xác nhận tuần tự,
tránh trường hợp `seedBookTerms`/`sealBookTerms` bị gửi hoặc gán nonce trước
khi giao dịch `CREATE` tạo contract hoàn tất.

### Xuất và kiểm chứng artifact/evidence thư viện

Từ gốc repo:

```sh
node contracts/script/export-library-deployment.mjs \
  --broadcast contracts/broadcast/DeployLibrary.s.sol/20261/run-latest.json \
  --environment local-anvil \
  --output /tmp/library-local-deployment.json
```

Tuỳ chọn:

- `--base <core-manifest.json>`: giữ nguyên thông tin 3 contract L06 đã deploy và
  gắn khối `library` vào manifest mở rộng, đồng thời kiểm tra `escrow` và
  `treasury` không trùng địa chỉ trong manifest gốc.
- `--template --output <unconfigured.json>`: xuất khung `status: "unconfigured"`
  từ build artifact hiện tại đã xác minh hash nguồn Solidity.
- `--replace`: bắt buộc truyền nếu ghi đè một file đích đã có `status: "deployed"`.
  Exporter luôn từ chối ghi trực tiếp lên file chuẩn `deployments/intracampus.json`.

### Cấu trúc evidence cục bộ (`local-anvil`)

Khối `library` do `export-library-deployment.mjs` xuất và kiểm chứng qua
`requireLibraryDeployment(manifest, { allowLocal: true })` gồm các trường:

- Định danh mạng & thời điểm kiểm chứng: `schemaVersion` (`1`), `status`
  (`"deployed"`), `chainId` (`20261`), `abiVersion` (`1`), `environment`
  (`"local-anvil"` chỉ chấp nhận loopback RPC và `web3_clientVersion` chứa
  `anvil`; `"avalanche-l1"` từ chối Anvil), `generatedAt`, `verifiedAt`
  (`blockNumber`, `blockHash`).
- Contract escrow: `escrow.{address, abiVersion, abi, transactionHash, blockNumber, blockHash, runtimeCodeHash}`
  (kiểm tra runtime trên chain khớp artifact vừa build từ nguồn hiện tại).
- Quyền và quỹ: `roles.{deployer, administrator, librarian}` và `treasury`.
- Chính sách cố định đối chiếu on-chain: `policy.{depositWei, approvalWindowSeconds, loanDurationSeconds, gracePeriodSeconds, lateFeeIntervalSeconds, lateFeePerIntervalWei, maxLateFeeWei, fullDepositRetentionAfterSeconds}`.
- Sách đã niêm phong: `books[]` (`bookId`, chuỗi wei nguyên `depositWei` và
  `replacementPriceWei`, `sealed: true`) và `seedTransactions[]` (`type`,
  `bookId`, `transactionHash`, `blockNumber`, `blockHash`).

Chạy kiểm tra cục bộ cho module hợp đồng và exporter:

```sh
cd contracts
forge fmt --check
forge build
forge test --match-contract LibraryDepositEscrow
cd ..
node --test contracts/test/export-library-deployment.test.mjs contracts/test/export-deployment.test.mjs
```
