# L04 · Review PR #8 · 2026-11-11

Phạm vi: diff từ `be72a2c461ab5c6469c4b1f89c2cabf392aad27e` đến PR #8,
đối chiếu AGENTS.md, tiêu chí L04 trên sprint, P02 và L03. Bản đầu được review
là `f254694f91c2ddd22bd93ebc99a3fe62cee540f0`.

## Lỗi có bằng chứng và đã sửa

**P2 — Smoke test có thể dùng artifact cũ rồi ghi hash source mới.**
Trước bản sửa, thêm comment vào `CampusPaymentRegistry.sol` sau khi build rồi
chạy smoke vẫn exit 0, báo hai receipt đã xác minh và ghi hash source đã đổi.
Metadata compiler chứng minh source hiện tại khác input đã tạo bytecode.
Như vậy evidence có thể bị gắn nhầm với source chưa được kiểm tra.

`load-verified-artifact.mjs` hiện kiểm tra keccak256 từng source trong metadata,
bao gồm dependency, trước khi smoke mở Anvil. Source không khớp hoặc metadata
thiếu/rỗng làm script thất bại với hướng dẫn build lại. Năm regression Node
kiểm tra artifact hợp lệ, source contract đổi, dependency đổi và metadata
thiếu/rỗng. `pnpm test:l04` được ghép vào `pnpm test` để chạy trong CI.

## Đối chiếu nghiệm thu và tình huống biên

| Yêu cầu | Bằng chứng kiểm tra |
| --- | --- |
| Typed data/signer P02 | Fixture chữ ký thật được dùng trên implementation; sai signer, sửa mọi field, sai chain/verifier bị chặn |
| Chữ ký canonical | Test mới tạo high-s + flipped v vẫn recover đúng signer rồi xác nhận bị từ chối; compact 64 byte và overlong bị từ chối; chữ ký canonical có thể retry |
| Giá thường/ưu đãi | Tier 0/1, SBT hết hạn/thu hồi, rounding fixture, fuzz uint256, quote tại uint256 tối đa |
| Dùng tier lúc thực thi | Test hết hạn sau quote và test mới thu hồi sau quote: value cũ revert, paid flag/balance giữ nguyên, quote mới thanh toán được |
| Hạn invoice | Đúng expiresAt vẫn thành công; sau hạn cả quote và pay đều revert |
| Merchant/category | Quyền admin, cặp không khớp, merchant/category bị tắt sau khi ký; test mới chứng minh tắt một category không tắt category khác |
| Thu đúng value/chuyển native | Thiếu/thừa/zero value, bảo toàn tiền bằng fuzz; merchant từ chối nhận tiền rollback toàn bộ và retry thành công |
| Chống replay/reentrancy | Replay qua payer và payload, paid flag trước callback; test mới chặn callback trả một invoice khác hợp lệ, invoice đó vẫn trả được sau outer call |
| Nhiều invoice trên cùng registry | Test mới thanh toán liên tiếp, paid flag độc lập và guard mở lại sau thành công |
| Event/receipt theo P02 | Test mới kiểm tra topic0, thứ tự ba indexed topic và decode raw event data theo kiểu P02; smoke đối chiếu full ABI và hai receipt thật trên Anvil |

Không phát hiện lỗi runtime có thể tái hiện trong contract thanh toán theo
giao kèo hiện tại. Bản sửa giữ nguyên code contract, ABI, schema, dependency,
constructor và quyền đã chốt. Những ca trên bổ sung bằng chứng kiểm tra cho
các đường lỗi và race chưa được khóa rõ trong suite cũ.

## Kiểm tra sau sửa và giới hạn

- `forge fmt --check`, `forge build`, `forge test -vv`: 45/45 test qua,
  gồm 34 L04; hai fuzz test, mỗi test 256 trường hợp.
- `pnpm test:l04`: 5/5 regression Node qua.
- Smoke Anvil: source/artifact khớp metadata, ABI khớp P02, hai receipt thường/
  ưu đãi hợp lệ và replay bị từ chối. Log/receipt local đi cùng PR được cập nhật.
- Bằng chứng này là EVM local; chưa phải giao dịch Avalanche L1. L06 và các
  task tích hợp vẫn chịu trách nhiệm bản deploy cuối.

Review trực tiếp đã hoàn tất. Reviewer độc lập qua `review-impl` dừng ở vòng 1
trước khi đưa ra verdict: model `gpt-6-luna` trong cấu hình mặc định bị tài
khoản Codex từ chối (`model_not_found`). Không có nhận xét độc lập để chấp
nhận/tranh luận; không coi lần chạy đó là approve. Vẫn cần review nghiệm thu
của thành viên khác theo quy trình nhóm.
