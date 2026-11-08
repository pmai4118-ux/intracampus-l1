# L01 · IntraCampus L1 local

RPC HTTPS cho thiết bị khác tiếp tục ở [runbook L02](rpc.md), gồm gateway chỉ mở RPC cần dùng, script kiểm tra và checklist Wi-Fi/4G. Tunnel phải chạy trên máy đang giữ node L01.

| Thông số | Giá trị |
| --- | --- |
| Mạng | IntraCampus L1 |
| EVM chain ID | `20261` (`0x4f25`) |
| Đồng gốc | `CAMPUS`, 18 chữ số thập phân, dùng để chuyển tiền và trả gas |
| Công cụ dựng local | Avalanche CLI `v1.9.4`, AvalancheGo `v1.14.0`, Subnet-EVM `v0.8.0` |
| Ví CLI | Foundry `v1.7.1` (`cast`) |

## Dựng mạng

Chạy từ thư mục gốc của repo trên Linux hoặc Ubuntu WSL2. Dùng các bản phát hành đã ghim dưới đây. Avalanche CLI đang ở chế độ bảo trì. Quy trình này dùng mạng local và địa chỉ `ewoq` công khai, chỉ dành cho dữ liệu thử nghiệm. [Avalanche CLI v1.9.4](https://github.com/ava-labs/avalanche-cli/releases/tag/v1.9.4) · [Subnet-EVM v0.8.0 và AvalancheGo tương thích](https://github.com/ava-labs/subnet-evm/releases/tag/v0.8.0) · [Foundry v1.7.1](https://github.com/foundry-rs/foundry/releases/tag/v1.7.1)

[Genesis local](genesis.json) dựa trên cấu hình thử nghiệm của Avalanche CLI và đặt `minBaseFee` là 1 gwei. `alloc` cấp 1.000.000 CAMPUS cho địa chỉ `ewoq`. Ký hiệu `CAMPUS` được khai báo qua `--evm-token` và trong cấu hình ví. Subnet-EVM dùng số nguyên ở đơn vị nhỏ nhất cho `alloc`, số dư và phí.

```bash
DEMO_SENDER=0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC
avalanche --skip-update-check blockchain create IntraCampus --local \
  --evm --genesis "$PWD/infra/genesis.json" --evm-token CAMPUS --vm-version v0.8.0 \
  --sovereign=true --proof-of-authority --validator-manager-owner "$DEMO_SENDER" \
  --proxy-contract-owner "$DEMO_SENDER" --icm=false --debug=false
avalanche --skip-update-check blockchain deploy IntraCampus --local \
  --avalanchego-version v1.14.0 --ewoq --vmc-c-chain --vmc-genesis-key
```

Lấy URL RPC của **IntraCampus** từ kết quả deploy. URL có dạng `http://127.0.0.1:<cổng>/ext/bc/<blockchain-id>/rpc`, trong đó `<blockchain-id>` là ID do Avalanche cấp khi deploy. Dùng URL này để thêm mạng tùy chỉnh trong ví với tên, chain ID và ký hiệu ở bảng trên. Từ Windows với WSL2, dùng địa chỉ loopback nếu chuyển tiếp localhost đang hoạt động. RPC HTTPS cho điện thoại thuộc L02.

## Xác minh giao dịch CAMPUS

Điền URL RPC thật bên dưới. Có thể đặt cùng giá trị vào `backend/.env` dựa trên `backend/.env.example`. `pnpm rpc:check` phải trả `ready` và `chainId: 20261` trước khi gửi giao dịch. Với Foundry, alias `intracampus` trong `contracts/` đọc biến `INTRACAMPUS_RPC_URL`.

```bash
export INTRACAMPUS_RPC_URL='http://127.0.0.1:<cổng>/ext/bc/<blockchain-id>/rpc'
pnpm rpc:check
cast rpc --rpc-url "$INTRACAMPUS_RPC_URL" eth_chainId
```

Nhập khóa test `ewoq` qua lời nhắc ẩn của `cast wallet import`. Tạo ví nhận riêng và đặt mật khẩu cho hai keystore. Giữ keystore, khóa và mật khẩu ngoài Git, log và bảng sprint. [Địa chỉ và khóa test ewoq từ Avalanche Builder Hub](https://build.avax.network/academy/blockchain/solidity-foundry/03-smart-contracts/03-foundry-quickstart)

```bash
cast wallet import campus-sender --interactive
mkdir -p ~/.foundry/keystores
cast wallet new ~/.foundry/keystores campus-recipient
DEMO_SENDER=$(cast wallet address --account campus-sender)
DEMO_RECIPIENT=$(cast wallet address --account campus-recipient)

cast rpc --rpc-url "$INTRACAMPUS_RPC_URL" eth_getBalance "$DEMO_SENDER" latest
cast rpc --rpc-url "$INTRACAMPUS_RPC_URL" eth_getBalance "$DEMO_RECIPIENT" latest
cast send --rpc-url "$INTRACAMPUS_RPC_URL" --chain 20261 --account campus-sender \
  --value 1000000000000000000 "$DEMO_RECIPIENT"
```

Thay `<tx-hash>` bằng hash trả về. Dùng cùng hash ở hai tài khoản ví để kiểm tra địa chỉ gửi và nhận.

```bash
TX_HASH='<tx-hash>'
cast tx --rpc-url "$INTRACAMPUS_RPC_URL" "$TX_HASH" from
cast tx --rpc-url "$INTRACAMPUS_RPC_URL" "$TX_HASH" to
cast rpc --rpc-url "$INTRACAMPUS_RPC_URL" eth_getTransactionReceipt "$TX_HASH"
cast rpc --rpc-url "$INTRACAMPUS_RPC_URL" eth_getBalance "$DEMO_SENDER" latest
cast rpc --rpc-url "$INTRACAMPUS_RPC_URL" eth_getBalance "$DEMO_RECIPIENT" latest
```

Đối chiếu `status = 0x1`. Ví nhận phải tăng đúng `1000000000000000000` đơn vị. Ví gửi phải giảm đúng khoản chuyển cộng với `gasUsed × effectiveGasPrice`. Thực hiện trên hai ví thử nghiệm không có giao dịch đồng thời để so sánh số dư trước và sau. Ghi lại hash, `blockNumber`, `status`, `gasUsed`, `effectiveGasPrice` và chênh lệch số dư của lần chạy.

## Bằng chứng chạy local ngày 2026-11-08

| Kiểm tra | Kết quả |
| --- | --- |
| Môi trường | Ubuntu 24.04 trên WSL2, distro `IntraCampus-L01-Ubuntu` |
| Blockchain ID | `ei1KeTdVU9HTCEPGRgYUBAqpd7CyHxGJUDzoseXQFQHubTXfW` |
| P-Chain `ConvertSubnetToL1Tx` | `28725qrgR7ufNeLd9Q33rWyUmoJ92jJa8uEu7P8Gt9d744cexg`, `platform.getTxStatus` trả `Committed` |
| RPC local | `http://127.0.0.1:9654/ext/bc/ei1KeTdVU9HTCEPGRgYUBAqpd7CyHxGJUDzoseXQFQHubTXfW/rpc` |
| Kiểm tra chain | `eth_chainId` trả `0x4f25`, `pnpm rpc:check` trả `ready`, `web3_clientVersion` trả `v0.8.0` |
| SHA-256 của genesis | `f55954859267e967f595265a1fba5cbada86b08184cd004202f9235ad4c01a9c` khớp file CLI đã import |

Ví A (`ewoq`) là `0x8db97C7cEcE249c2b98bDC0226Cc4C2A57BF52FC`. Ví B là `0x8aDd69AcDfDB91F2ad6d242f8914872a9Eba6ADe`. Hai ví ký lần lượt bằng Foundry `cast`. Hash và các trường receipt từ `cast send` khớp với `eth_getTransactionReceipt`.

| Giao dịch | Hash | `blockNumber` | `status` | `gasUsed` | `effectiveGasPrice` (wei) |
| --- | --- | ---: | --- | ---: | ---: |
| A → B, 1 CAMPUS | `0xc5ba59aae9dd2bcf2aca95b10f05a0e540b7671fc4e3d70fc1537dc9156566b7` | 1 | `0x1` | 21000 | 1000000001 |
| B → A, 0,25 CAMPUS | `0x5761c3b1f8f7053f871899b66767034b011f965ec454b328b83b4ac3822f8957` | 2 | `0x1` | 21000 | 1000000001 |

Mỗi giao dịch tốn `21000000021000` wei. Số dư đọc bằng `eth_getBalance` khớp khoản chuyển và phí ở cả hai chiều.

| Thời điểm | Ví A (wei) | Ví B (wei) |
| --- | ---: | ---: |
| Trước giao dịch | `1000000000000000000000000` | `0` |
| Sau A → B | `999998999978999999979000` | `1000000000000000000` |
| Sau B → A | `999999249978999999979000` | `749978999999979000` |
