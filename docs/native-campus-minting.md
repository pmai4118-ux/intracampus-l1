# Mint CAMPUS through the cloud Native Minter

## Understanding summary

- The cloud demo uses chain `20261120`; the local development chain `20261` stays unchanged.
- `/admin` currently sends CAMPUS from the VM funder's existing balance.
- Student welcome grants currently require a Treasury wallet to sign each transfer.
- The cloud Native Minter will mint native CAMPUS for both `/admin` test funding and student welcome grants.
- A student's approval automatically starts a one-time 20 CAMPUS welcome mint.
- Previously approved students without a recorded welcome grant get an explicit backfill action; deployment itself never mints to existing accounts.
- FOOD grants, POS payments, contract addresses, and student login signatures stay on their current paths.

## Assumptions

- The existing VM `ADMIN_FUNDER_PRIVATE_KEY` remains the only online mint signer and never leaves the VM.
- Treasury retains Native Minter Admin. It signs one `setEnabled(funder)` transaction once; the VM funder then receives the Native Minter Enabled role.
- The `/admin` mint action has a hard application limit of 100,000 CAMPUS per request. This is not an on-chain supply cap.
- Mint operations remain available only to authenticated school or internal admin sessions. The VM funder pays gas from its existing native CAMPUS balance.

## Decision log

1. **Mint native CAMPUS with the Native Minter on cloud.** Alternatives were keeping Treasury-signed transfers or only transferring from the funder's existing balance. The user chose Native Minter so campus issuance no longer prompts Core on each operation.
2. **Mint welcome on approval.** The 20 CAMPUS welcome grant is fixed, one-time per wallet, and initiated after a school/admin approval. Already approved accounts use a separate backfill action to avoid silent minting on deployment.
3. **Reuse the VM funder.** No new private key is created. The funder is checked with `readAllowList`; minting fails closed unless it has Enabled, Manager, or Admin permission.
4. **Keep durable transaction state.** Persist the payout before broadcast, attach one transaction hash, verify the NativeCoinMinted event and canonical receipt, and reconcile an unknown result against the same transaction. Never issue a second mint to resolve an uncertain result.
5. **Cap admin mint input.** The API and UI cap each arbitrary test mint at 100,000 CAMPUS; welcome grants stay fixed at 20. A compromised enabled key can bypass this application cap, so VM key access remains restricted.

## Final design

The Native Minter precompile at `0x0200000000000000000000000000000000000001` exposes `mintNativeCoin(address,uint256)` and an allowlist role read. Backend code uses the existing funder signer on chain `20261120`; it checks the chain ID and funder role before signing. Treasury performs only the one-time role grant in Core. The server signs each later mint, so the school UI does not open Core for welcome payouts.

The `/admin` CAMPUS test action mints to the selected wallet and records the target, amount, transaction hash, and result in the existing admin audit. Approval routes in both `/staff/students` and `/admin` enqueue the fixed welcome amount in the Campus SQLite database before submitting the mint. The unique wallet/kind payout record prevents duplicate welcome grants. Approved profiles that predate this feature do not receive funds in a deployment migration; an explicit backfill button routes through the same idempotent state machine.

The UI reports Native Minter readiness separately from the existing `5/5` VM signer count. Missing role, wrong chain, insufficient gas, failed simulation, reverted receipt, or unknown broadcast outcome is shown as a specific status. A successful welcome requires a canonical receipt and matching `NativeCoinMinted(sender,recipient,amount)` event. Local chain `20261`, POS, FOOD grants, library contracts, and other signer roles are unchanged.

## Operational limits

Before deploying this change or granting the VM signer a Native Minter role, snapshot the VM disk and create consistent SQLite backups for Campus, Admin, invoices, library, and canteen; verify the copies can be opened. Do not copy a live `.db` file without its WAL state. These backups protect application records, not on-chain supply.

Native Minter permission is powerful and does not impose an on-chain supply cap. The 100,000 CAMPUS limit protects the authenticated `/admin` application route only. Treasury can revoke the funder's role with `setNone(funder)` if needed. Minted CAMPUS cannot be rolled back; an application rollback stops future mints but does not remove already issued CAMPUS.
