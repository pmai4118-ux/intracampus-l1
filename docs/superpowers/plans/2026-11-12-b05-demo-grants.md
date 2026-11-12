# B05 implementation plan

Goal: seed one FOOD grant of 5000 CAMPUS per deployment/demo student and expose verified read-only data to U05.

Spec: the B05 request in this chat, `docs/l05-grants.md`, `docs/deployment.md`, `docs/demo-accounts.md`.

Architecture: reuse B03 account parsing, L06 manifest validation and ABI, ethers and Node SQLite already present. A grants reader owns chain, code, role, block and receipt validation. HTTP exposes that reader; the CLI owns issuer signing. Durable seed intent is committed before broadcasting, and prior issuance is reconciled from verified events, never the remaining balance.

## Constraints and decisions

- Chain 20261; native CAMPUS with 18 decimals; bigint internally and decimal wei strings in JSON.
- One fixed B05 FOOD allocation per deployment and B03 student. No configurable amount, top-up, student signing or grant mutation HTTP endpoint.
- Default CLI dry-run performs no writes and needs no key. Only `--apply` may broadcast.
- Store only public intent/hash/nonce in the local journal, not keys or raw signed transactions. Unknown outcome blocks another grant. An interrupted intent without a receipt may require operator reconciliation.
- A journal is shared by all seed invocations on the issuer machine. Do not delete it or run separate seed hosts concurrently. History protects reruns after confirmed issuance even when no journal exists.
- API balance and merchant permission share a canonical block. Error means unverified/null balance, never zero.
- No changes to ABI/P02, contracts, student UI, main, deployment, sprint or remote branches.
- main `3b1d136` lacks L05/L06 despite closed/merged PRs because their merge targets were feature branches. B05 is stacked on L06 `eba14b8`; integration into main waits for the dependency fix by the team. Preserve all existing branches.
- Sprint unavailable via web reader in this session; implement the explicit user acceptance and repo contracts.

## Work and proof

- [x] Read API: `backend/src/modules/grants/grants.types.ts`, `grants.rpc.ts`, `grants.service.ts`, `grants.routes.ts`; HTTP/RPC tests `backend/test/grants-read*.ts`. Observe failing tests before code, then verify 0 vs unknown, chain/issuer/code/deployment checks, canonical receipts and malformed requests.
- [x] Seed: `backend/scripts/seed-grants.ts`, `grants.seed-repository.ts`; test `backend/test/seed-grants.test.ts`. Observe failing tests for dry-run, one grant, post-spend rerun, durable interruption, concurrent claim, wrong configuration and mismatched receipt, then implement minimal behavior and rerun.
- [x] Integrate router in `app.ts`, configure read service in `server.ts`, add CLI scripts and public env examples. No grant HTTP writes.
- [x] Anvil: `backend/test/grants-local-evidence.ts` starts an isolated node, deploys verified artifacts and exercises production seed + HTTP. Prove 5000 → 4000, no duplicate issuance, rejected actual spends preserve balance. Record only public evidence.
- [x] Run `pnpm typecheck`, `pnpm test`, `pnpm build`, focused local evidence and `git diff --check`. Review the full B05 diff independently and fix material findings with regression tests.
- [x] Handoff API/CLI/config, source of dependencies, fresh check results, limitations and issuer/operator actions in `docs/b05-grants.md` and decision log.

## Review focus

Unknown broadcast before a hash is returned; crash after on-chain confirmation; concurrent seed processes; RPC history/receipt mismatch; chain reset reusing addresses. Tests must fail closed without another issuance and without leaking RPC errors or credentials.
