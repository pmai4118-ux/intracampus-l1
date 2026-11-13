# B05 · Seed và đọc học bổng FOOD

B05 cấp một khoản **5.000 CAMPUS FOOD** cho `student.address` của cấu hình B03, qua `PurposeBoundGrantVault` L05. U05 dùng ví sinh viên gọi `spend` để chi 1.000 tại căn-tin, còn 4.000. Tiền là native CAMPUS, `1 CAMPUS = 10^18 wei`. B05 không giữ khóa sinh viên hoặc cung cấp HTTP để cấp/chi học bổng.

## Phụ thuộc và trạng thái

Nhánh `codex/B05-demo-grants` đã cập nhật theo `main` tại `4ec299e` ngày 2026-11-13. Main hiện chứa B03/L05/L06 qua tích hợp B04; diff PR B05 chỉ còn module grants, seed, cấu hình tích hợp, test và tài liệu B05. Trước đó nhánh xếp trên L06 `eba14b8` do main cũ thiếu phụ thuộc; rào cản phạm vi đó đã được xử lý bằng cập nhật main, không tự merge PR phụ thuộc.

Đã đọc B03 #10, L05 #11, L06 #12, tài liệu/ABI và loader manifest. Bảng sprint không truy cập được bằng công cụ đọc trong phiên này; tiêu chí triển khai theo yêu cầu B05 được giao. Manifest canonical `deployments/intracampus.json` vẫn `unconfigured`. Chưa có nghiệm thu Avalanche L1 của nhóm.

## Chuẩn bị địa chỉ và RPC

- L02 cung cấp RPC đúng `20261`; L06 xuất manifest đã kiểm chứng từ cùng blockchain. Địa chỉ vault, registry, grant issuer, căn-tin FOOD, ABI, runtime hash và block deploy đều lấy từ manifest.
- Dùng lại file tài khoản công khai B03, ví dụ `backend/.env.demo-accounts.json`. Người nhận là `student.address`; không dùng địa chỉ mẫu nguyên trạng. Người nhận phải khác vai trò quản trị, merchant, các contract và ví thường/funder.
- `backend/.env` chứa `INTRACAMPUS_RPC_URL`. Chỉ `--apply` mới cần `SEED_GRANT_ISSUER_PRIVATE_KEY`, tương ứng `roles.grantIssuer` và `vault.issuer()`. Issuer cần ít nhất 5.000 CAMPUS cộng gas. Không đặt khóa trong tham số dòng lệnh.
- API production dùng manifest canonical qua loader L06. Sau thay deployment, build và khởi động lại backend/frontend. `--deployment` của CLI chọn file công khai riêng, không thay cấu hình API.

Từ gốc repo, Node 24 và pnpm 11.25.0:

```sh
pnpm rpc:check
pnpm --filter @intracampus/backend seed:grants --help
pnpm --filter @intracampus/backend seed:grants --accounts .env.demo-accounts.json --deployment ../deployments/intracampus.json
```

Lệnh cuối là dry-run: kiểm tra chain, code/hash và block deploy canonical, issuer/registry liên kết, merchant/category, số dư và lịch sử cấp. Không cần khóa và không gửi giao dịch. Khi thiếu deployment hoặc RPC, dừng bằng mã lỗi, không giả lập khoản cấp.

Người giữ ví issuer kiểm tra địa chỉ và kế hoạch rồi tự chạy:

```sh
pnpm --filter @intracampus/backend seed:grants --accounts .env.demo-accounts.json --deployment ../deployments/intracampus.json --journal data/grant-seed.sqlite --apply
```

Đây là hướng dẫn bàn giao, không xác nhận đã chạy lệnh trên L1. `--allow-local` chỉ phục vụ manifest `local-anvil` với RPC loopback, không biến địa chỉ local thành deployment thật.

## Chống cấp trùng và phục hồi

Một đợt demo B05 được định danh theo deployment vault/block hash, issuer, người nhận và FOOD. Khoản cấp cố định `5000000000000000000000` wei. Không có tùy chọn mở thêm đợt hoặc đổi số tiền.

Seed quét `GrantIssued` từ block deploy theo khoảng 1.000 block, đối chiếu receipt thành công và event đúng vault/người nhận/category/issuer. Nếu index trả rỗng, đối chiếu thêm danh sách giao dịch và receipt trong từng block canonical trước khi kết luận chưa cấp; RPC thiếu receipt làm dừng. Cách này phục hồi khi index thiếu log và khoản cũ đã tiêu hết. Một khoản 5.000 đã xác minh thì bỏ qua. Sau khi chi còn 4.000 hoặc 0, vẫn bỏ qua. Khoản cấp khác hoặc nhiều khoản cấp làm dừng `EXISTING_GRANT_CONFLICT`; không đoán số cần bù. Đổi lại, lần cấp đầu hoặc phục hồi thiếu journal có thể đọc nhiều block/receipt, phù hợp chuỗi demo ngắn; với lịch sử dài cần giữ journal và chuẩn bị nguồn RPC đủ năng lực trước buổi demo.

Trước broadcast, CLI ký trong bộ nhớ, kiểm tra toàn bộ giao dịch rồi commit hash/nonce vào SQLite với `synchronous=FULL` và khóa duy nhất. Dòng `grant-seed-intent` in hash công khai sau commit và trước gửi để operator đối chiếu khi mất mạng. Journal không lưu khóa hoặc raw signed transaction. Lần chạy sau đối chiếu hash đã ghi trước khi cân nhắc giao dịch mới. Giữ journal mặc định `backend/data/grant-seed.sqlite` trên volume bền vững, kèm WAL theo quy tắc backup SQLite.

| Kết quả | Cách xử lý |
| --- | --- |
| `planned` | Chưa có khoản cấp; dry-run không thay đổi chain |
| `confirmed` | Receipt thành công và `GrantIssued` đúng; lưu hash và đọc số dư lại |
| `already-issued` | Đã đối chiếu khoản cấp trước; không gửi thêm |
| `SEED_OUTCOME_UNKNOWN` | Intent đã lưu nhưng chưa có receipt. Giữ journal, tra hash; chạy lại chỉ để đối chiếu |
| `SEED_REVERTED_RETRY_ALLOWED` | Reader đã xác minh receipt revert canonical. Apply lưu lịch sử intent thất bại rồi dừng; lần chạy apply tiếp theo sẽ kiểm tra toàn bộ trước khi ký lại |
| `ISSUER_NONCE_CHANGED`, lỗi preflight trước gửi | Transport xác nhận chưa gọi broadcast: chuyển intent sang lịch sử `not-broadcast`, báo nguyên nhân; có thể sửa cấu hình/chờ nonce ổn định rồi chạy lại |
| `SEED_RECEIPT_MISMATCH` | Giữ intent, không báo cấp thành công; người vận hành kiểm tra hash và contract |
| `ISSUER_HAS_PENDING_TRANSACTIONS` | Đợi/đối chiếu giao dịch issuer trước; không chạy song song với tác vụ khác |
| `WRONG_CHAIN`, `DEPLOYMENT_MISMATCH`, `RPC_UNAVAILABLE` | Sửa nguồn cấu hình/kết nối, không đổi địa chỉ để né kiểm tra |

Dry-run không thay đổi journal. Nếu intent cũ có receipt revert canonical, kế hoạch trả `status: planned`, `recovery: canonical-revert` và hash cũ. Apply xác minh lại, chuyển đúng intent/hash sang bảng lịch sử `grant_seed_retired` với lý do `canonical-revert` rồi dừng, yêu cầu operator chạy lại rõ ràng. Lỗi chắc chắn trước lời gọi `provider.broadcastTransaction` được transport phân loại riêng và lưu lý do `not-broadcast`. Việc lưu lịch sử và gỡ khóa đúng hash diễn ra trong một transaction SQLite; không gỡ intent mới của tiến trình khác. Database cũ được bổ sung bảng lịch sử khi mở ở chế độ ghi.

Nếu crash mà chưa có bằng chứng giai đoạn gửi hoặc RPC timeout sau khi bắt đầu broadcast, journal vẫn giữ trạng thái chưa rõ. Không có nút tự xóa intent hoặc tự thay thế nonce. Người giữ issuer cần đối chiếu receipt, nonce, mempool và lịch sử trên node trước khi xử lý thủ công. Receipt thiếu, orphan, không khớp hoặc thông báo lỗi thô có chữ “revert” không cho phép gỡ khóa. Một receipt thành công tìm được ở lần chạy sau đủ để tiếp tục đọc; chưa biết kết quả thì không gửi grant mới.

Tất cả tiến trình seed phải dùng **cùng một journal trên một máy issuer**. Không xóa journal, không chạy từ hai máy/kho dữ liệu khác nhau và không dùng issuer gửi tác vụ khác đồng thời. Hợp đồng L05 không có seed ID/chống cấp trùng trên chain; bảo đảm chống cấp trùng đang gửi dựa vào journal chung và lịch sử RPC tin cậy. RPC phải cung cấp đầy đủ logs và state lịch sử từ block triển khai; lỗi đọc làm dừng.

## Reset dữ liệu demo mà không thay đổi ví khác

### L1 hoặc node dùng chung: không rollback, không xóa journal

Vault L05 không có quyền thu hồi/reset riêng một grant đã cấp. Xóa SQLite, xóa intent hoặc chạy lại B03 không hoàn tác `grant`/`spend` và không đưa số dư 4.000 về 5.000. Giữ journal để đối chiếu, dùng lại ngân sách còn lại. Nếu cần kịch bản sạch, chuẩn bị **ví sinh viên demo mới** trong file cấu hình B03 riêng và cấp một khoản mới sau khi issuer đồng ý; các ví cũ, grant cũ và journal của chúng được giữ nguyên. Khoản cấp mới vẫn dùng ngân sách/gas thật của issuer. Không tự `grant` thêm cho ví cũ để gọi đó là reset.

RPC lỗi, receipt-null hoặc sai deployment chưa phải bằng chứng rollback. Trên L1 dùng chung, không chạy `evm_revert`, `anvil_reset`, ghi đè state hay xóa journal để vượt `SEED_OUTCOME_UNKNOWN`. Nếu mạng đã bị reset bởi operator, cần bàn giao deployment và lịch sử mới rõ ràng; không chỉ dựa vào chain ID 20261. Không có thao tác reset on-chain tự động trong B05.

### Anvil local dùng riêng: checkpoint có kiểm soát, đối chiếu rồi gỡ đúng một intent

Chỉ áp dụng trên node **Anvil tạm, loopback, do chính người chạy demo sở hữu**, manifest `environment: local-anvil`, không có thiết bị/người dùng khác gửi giao dịch. `evm_revert` khôi phục **toàn node**, không riêng một ví. Chỉ giữ được ví khác khi checkpoint đã chứa trạng thái của họ và không có hoạt động của họ sau checkpoint. Nếu không chứng minh được điều này, dừng quy trình; dùng node/deployment demo riêng mới, không rollback node đang dùng chung.

1. **Trước demo**, sau deploy/allowlist và sau khi chuẩn bị các ví đối chứng, tạo checkpoint bằng `evm_snapshot`. Ghi snapshot ID, block number/hash, manifest vault/block deploy, issuer, beneficiary, FOOD; ghi số dư native, nonce và grant của ví đối chứng. Người nhận cần số dư FOOD 0 tại checkpoint. Giữ snapshot của đúng phiên Anvil; không dùng một ID từ phiên node khác. Lưu kế hoạch seed/hash công khai và đường dẫn journal khi chạy demo.
2. **Dừng các tiến trình seed/UI đang ký và mọi tác nhân gửi lại giao dịch.** Chỉ trên node riêng nói trên, operator chủ động gọi `evm_revert` với snapshot đã ghi. Nếu ví khác đã giao dịch từ checkpoint, không làm bước này. Không dùng cách xóa journal đơn thuần để reset chain.
3. **Đối chiếu rollback trước khi sửa SQLite.** Kiểm tra `web3_clientVersion` là Anvil, RPC loopback/chain 20261; block checkpoint canonical; code/roles/allowlist và block deploy vẫn khớp manifest local. Với ví mục tiêu, kiểm tra FOOD về 0 và không còn cấp sau checkpoint. Receipt **và transaction** của hash seed cũ đều phải `null`; nonce issuer `pending` bằng `latest`, không còn transaction có thể phát lại. Nếu còn pending, receipt chưa rõ hoặc không kiểm soát được signer khác, dừng. So sánh lại ví đối chứng với giá trị checkpoint; chúng phải giữ nguyên. `SEED_OUTCOME_UNKNOWN` lúc này là hành vi đúng: operation ID vẫn khớp vì deployment không đổi, còn receipt seed đã bị rollback.
4. **Đóng sạch journal và sao lưu trước khi sửa.** Dừng mọi tiến trình đang mở DB. Sau khi SQLite đóng sạch, sao chép đúng file journal (mặc định `backend/data/grant-seed.sqlite`) tới bản backup riêng; nếu vẫn còn WAL/SHM hoặc có process giữ DB thì dùng backup SQLite nhất quán, không sao chép thiếu WAL rồi xóa. Không xóa/ghi đè cả DB và không thao tác `invoices.sqlite`.
5. **Chọn đúng một hàng.** Dùng hash seed cũ tra `SELECT * FROM grant_seed_intents WHERE transaction_hash = :tx_hash`; phải đúng một hàng. Đối chiếu `operation_id` với `id(JSON.stringify(["b05-food-v1",20261,vaultAddressLower,vaultDeployBlockHashLower,grantIssuerLower,beneficiaryLower,foodLower,"5000000000000000000000"]))` (hàm `id` của ethers). Các giá trị lấy từ manifest/config đã ghi, không lấy từ ví đang mở ngẫu nhiên. Giữ nguyên các hàng của ví khác và bảng lịch sử `grant_seed_retired`.
6. **Lưu bằng chứng reset rồi gỡ đúng intent đã rollback.** Dùng SQLite transaction dưới đây, bind các tham số bằng giá trị đã đối chiếu. Chỉ làm sau đầy đủ bước 1–5, không áp dụng cho receipt-null do RPC lỗi. Sau mỗi lệnh ghi, `SELECT changes()` phải bằng 1; nếu khác, chạy `ROLLBACK`, dừng và đối chiếu lại, không nới điều kiện WHERE.

```sql
CREATE TABLE IF NOT EXISTS grant_seed_local_resets (
  operation_id TEXT, transaction_hash TEXT, nonce INTEGER,
  snapshot_id TEXT, rollback_block_hash TEXT
) STRICT;
BEGIN IMMEDIATE;
INSERT INTO grant_seed_local_resets
SELECT operation_id, transaction_hash, nonce, :snapshot_id, :rollback_block_hash
FROM grant_seed_intents
WHERE operation_id = :operation_id AND transaction_hash = :tx_hash;
SELECT changes(); -- Phải bằng 1; nếu khác thì ROLLBACK và dừng.
DELETE FROM grant_seed_intents
WHERE operation_id = :operation_id AND transaction_hash = :tx_hash;
SELECT changes(); -- Phải bằng 1; nếu khác thì ROLLBACK và dừng.
COMMIT;
```

Không dùng `retire(..., "not-broadcast")` hoặc `canonical-revert` để mô tả rollback: giao dịch trước đó có thể đã thành công, chỉ bị xóa khỏi lịch sử node local. Bảng `grant_seed_local_resets` và backup giữ hash/nonce/checkpoint cũ để phân biệt tình huống này. So sánh các hàng journal ngoài `operation_id` mục tiêu với backup; chúng phải không đổi.

7. **Đóng editor DB, chạy dry-run lại** với đúng config, manifest local và `--allow-local`. Kế hoạch phải là `planned`, FOOD 0, cấp 5.000, đúng ví/căn-tin/issuer. Sau khi operator duyệt, chạy cùng lệnh với `--apply`. Đọc receipt mới và số dư **5.000**, chi lại 1.000 bằng ví sinh viên nếu cần kịch bản 4.000; kiểm tra ví đối chứng và các intent khác vẫn nguyên. Không tự gửi lại raw transaction cũ.

Harness `test:b05:local` tái hiện quy trình này: cấp grant cho ví đối chứng trước checkpoint, seed/chi ở ví mục tiêu, rollback node riêng, xác nhận intent cũ bị khóa, sao lưu và gỡ đúng hàng bằng transaction trên, rồi seed lại. Evidence `localReset` ghi ví đối chứng trước/sau, operation ID, hash cũ đã mất, kế hoạch mới và receipt/hash seed mới. Các receipt giai đoạn trước rollback được xác minh khi chúng còn canonical; sau rollback chúng cố ý không còn trên node. Đây chỉ là bằng chứng local, không phải reset hoặc nghiệm thu L1.

### Chi phí đọc trước khi gửi

Seed ghim history vào đúng hash snapshot rồi tái sử dụng trong **cùng một lần gọi** nếu snapshot ban đầu và pre-send có cùng block number **và** hash. History từ fork khác bị từ chối `CHAIN_CHANGED`. Nếu block tiến lên hoặc đổi fork cùng độ cao thì đọc lại history. Không cache kết quả qua lần chạy, không bỏ qua kiểm tra balance/allowlist trước gửi hoặc unique intent trong journal.

## Giao kèo HTTP cho U05

```http
GET /api/grants/0xStudentPublicAddress
GET /api/grants/0xStudentPublicAddress?txHash=0xTransactionHash
```

Địa chỉ phải là địa chỉ EVM khác zero; hash 32 bytes khác zero. Không nhận field query khác hoặc hash lặp. Đây là dữ liệu công khai của ví demo, chưa phải cơ chế xác thực tài khoản sinh viên. `Cache-Control: no-store` cho mọi response.

200 có dạng sau; đây là minh họa schema, chuỗi `0x…` cần thay bằng giá trị đầy đủ từ response thật:

```json
{
  "schemaVersion": 1,
  "status": "verified",
  "chainId": 20261,
  "beneficiary": "0x…",
  "vaultAddress": "0x…",
  "category": { "id": "0x2f6f5a261d6f4514c3f09a834720fe583c82f2ee4758ce9a45fbd67428e9f93d", "label": "FOOD" },
  "balanceWei": "4000000000000000000000",
  "block": { "number": 12, "hash": "0x…" },
  "allowedMerchants": [{ "id": "canteen", "address": "0x…", "allowed": true }],
  "transaction": null
}
```

`balanceWei: "0"` là số dư đã đọc thành công. Balance và allowlist hiện tại được đọc tại cùng block, kiểm tra lại hash và chain sau khi đọc. U05 chỉ định dạng tiền khi hiển thị.

Không truyền hash thì không tuyên bố đã cấp/chi. Có hash nhưng RPC chưa có receipt: `transaction: {hash, status:"pending", events:[]}`. Chỉ khi receipt thành công, đúng vault và canonical event mới trả `status:"verified"` cùng `GrantIssued`/`GrantSpent`, mỗi event gồm `transactionHash`, `blockNumber`, `blockHash`, `logIndex`, `beneficiary`, `category`, `amountWei`, `balanceWei` và `issuer` hoặc `merchant`. `event.balanceWei` là số dư ngay sau event; `response.balanceWei` là số dư block đang đọc, có thể khác.

Contract vault đã kiểm tra allowlist ngay lúc thực thi `spend`. Receipt thành công và event từ code vault đã kiểm chứng là bằng chứng của lần chi. Không suy ra tính hợp lệ của receipt cũ từ allowlist cuối block, vì merchant có thể bị gỡ sau lần chi trong cùng block. `allowedMerchants` phản ánh quyền hiện tại để U05 quyết định có cho thử chi mới hay không.

| HTTP | Mã lỗi | Ý nghĩa |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Địa chỉ/hash/query không hợp lệ |
| 422 | `TX_REVERTED` | Receipt đúng giao dịch/vault nhưng revert |
| 422 | `RECEIPT_MISMATCH` | Sai vault/event/người nhận/category/metadata hoặc receipt orphan |
| 503 | `DEPLOYMENT_NOT_CONFIGURED`, `INVALID_DEPLOYMENT` | Thiếu/sai manifest, local manifest không được bật production |
| 503 | `DEPLOYMENT_MISMATCH` | Sai code, block deploy, issuer hoặc registry |
| 503 | `WRONG_CHAIN` | RPC không phải 20261 |
| 503 | `RPC_UNAVAILABLE`, `CHAIN_CHANGED` | Đọc lỗi hoặc chain thay đổi trong lúc đọc; có thể thử lại |

Body lỗi luôn `{status:"unverified",chainId:20261,balanceWei:null,error:{code,retryable}}`. Hai lỗi có thể thử lại trả `Retry-After: 2`. Không đưa lỗi thô RPC vào response/log. U05 cần giữ trạng thái chưa xác minh và không biến `null` thành số dư 0.

U05 lấy ABI/address từ `/api/deployment`, dùng ví sinh viên ký `spend(canteen, FOOD, amountWei)`, sau đó gửi hash vào GET B05 để đối chiếu. Trước khi ký vẫn cần kiểm tra lại mạng, số dư và mô phỏng ở ví; B05 không gửi thay sinh viên. API B05 có thể được B06 gọi để đọc ngân sách, nhưng không cung cấp lịch sử chi tiêu đầy đủ hay quyền tác động ví.

## Kiểm chứng

```sh
pnpm typecheck
pnpm test
pnpm build
cd contracts
forge build --force
cd ..
pnpm --filter @intracampus/backend test:b05:local ../docs/fixtures/b05-local-evidence.json
```

Harness từ chối ghi đè file evidence đã có; chọn đường dẫn mới để tái chạy. Có thể đặt `ANVIL_BIN` nếu executable không trong PATH. Harness tự mở Anvil loopback 20261, deploy bytecode từ nguồn đã kiểm tra, tạo khóa issuer tạm chỉ trong bộ nhớ và dừng node khi xong. Không dùng RPC hoặc khóa operator.

`fixtures/b05-local-evidence.json` chứa request/response thực tế qua HTTP, manifest local, receipt cấp/chi và ba receipt revert đã mine. Chứng minh 5.000 → 4.000, căn-tin nhận 1.000, chạy seed lại/mở lại journal không gửi thêm, CLI dry-run và apply lại không nạp bù. Test tự động dùng RPC giả lập để kiểm tra sai chain/issuer/code, receipt bị sửa, fork thay đổi, lỗi RPC và seed gián đoạn. Đây là fixture và **Anvil local**, chưa phải L1.

Trước nghiệm thu L1, người giữ node cần cung cấp RPC/manifest thật; người giữ issuer tự dry-run/apply sau `pnpm rpc:check`; sinh viên xác nhận chi bằng ví qua U05; reviewer lưu hash cấp/chi/revert và đối chiếu GET cùng chain/vault. Không chia sẻ `.env`, journal chứa trạng thái chưa rõ hoặc log debug thô. Chỉ chia sẻ địa chỉ và receipt công khai đã rà soát.
