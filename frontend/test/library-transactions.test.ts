import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
import type { DeployedLibraryDeployment } from '@intracampus/network';
import fixture from '../../docs/fixtures/library-v1.json' with { type: 'json' };
import { LibraryApi } from '../lib/library-api.ts';
import { LibraryTransactions } from '../lib/library-transactions.ts';
import { WalletTransactionError } from '../lib/wallet.ts';
const account = `0x${'11'.repeat(20)}`, escrow = `0x${'22'.repeat(20)}`, id = `0x${'ab'.repeat(32)}`, bookId = `0x${'bc'.repeat(32)}`, hash = `0x${'cd'.repeat(32)}`;
function setup() {
  const deployment = { chainId: 20261, escrow: { address: escrow, transactionHash: hash, abi: fixture.abi }, treasury: `0x${'33'.repeat(20)}`,
    books: [{ bookId, depositWei: fixture.policy.depositWei }] } as unknown as DeployedLibraryDeployment;
  const iface = new Interface(fixture.abi);
  const request = { requestId: id, bookId, status: 'AWAITING_DEPOSIT', refundStatus: 'NONE', depositWei: null as string | null,
    depositIntent: { chainId: 20261, to: escrow, data: iface.encodeFunctionData('deposit', [id, bookId]), valueWei: fixture.policy.depositWei, requestId: id, bookId },
    approvalDeadline: null as number | null, loanId: null, transactions: [] as any[], createdAt: 1, updatedAt: 1 };
  const accountStatus = { held: false, checkedAt: 1, blockingLoanIds: [] };
  let sends = 0;
  const state = { address: account, chainId: BigInt(20261), canProceed: true };
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const wallet = { getSnapshot: () => state, sendTransactionWithGuard: async (_account: string, _tx: any, guard: () => void) => { guard(); sends++; return hash; } };
  const api = new LibraryApi(async path => {
    const p = String(path);
    if (p.endsWith('/session')) return Response.json({ account: { wallet: account, role: 'STUDENT' }, expiresAt: 1800000000 });
    if (p.endsWith('account-status')) return Response.json(accountStatus);
    return Response.json(p.endsWith('/transactions') ? { request } : request);
  });
  const options = { deployment, account, api, wallet, storage, lock: async (_key: string, run: () => Promise<void>) => run() };
  return { controller: new LibraryTransactions(options), options, request, accountStatus, wallet, state, storage, sends: () => sends };
}
test('preflight validates canonical calldata, recipient, value and selected account', async () => {
  const s = setup(); const call = await s.controller.prepare(id, 'deposit'); assert.equal(call.amountWei, fixture.policy.depositWei);
  s.request.depositIntent.to = account;
  await assert.rejects(s.controller.prepare(id, 'deposit'), /INTENT_MISMATCH/);
  s.state.address = escrow; await assert.rejects(s.controller.prepare(id, 'deposit'), /WALLET_SESSION_CHANGED/);
  assert.equal(s.sends(), 0);
});
test('send persists unknown before wallet and blocks duplicate/reload when hash is pending', async () => {
  const s = setup(); const call = await s.controller.prepare(id, 'deposit');
  s.wallet.sendTransactionWithGuard = async (_a, _tx, guard) => { guard(); assert.equal(s.controller.journal(id, 'deposit')?.phase, 'unknown'); return hash; };
  await s.controller.send(call);
  const reloaded = new LibraryTransactions(s.options);
  assert.equal(reloaded.journal(id, 'deposit')?.hash, hash);
  await assert.rejects(reloaded.send(call), /RECOVERY_REQUIRED/);
});
test('unknown broadcast survives error and can reconcile by request without inventing success', async () => {
  const s = setup(), call = await s.controller.prepare(id, 'deposit');
  s.wallet.sendTransactionWithGuard = async (_a, _tx, guard) => { guard(); throw new WalletTransactionError('SEND_OUTCOME_UNKNOWN', 'unknown'); };
  await assert.rejects(s.controller.send(call), /SEND_OUTCOME_UNKNOWN/);
  await s.controller.reconcile(id, 'deposit');
  assert.equal(s.controller.journal(id, 'deposit')?.phase, 'unknown');
  await assert.rejects(s.controller.send(call), /RECOVERY_REQUIRED/);
});
test('storage failure stops before broadcast; known wallet refusal permits retry', async () => {
  const s = setup(), call = await s.controller.prepare(id, 'deposit');
  s.storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(s.controller.send(call), /STORAGE_BLOCKED/); assert.equal(s.sends(), 0);
  const r = setup(), next = await r.controller.prepare(id, 'deposit');
  r.wallet.sendTransactionWithGuard = async (_a, _tx, guard) => { guard(); throw new WalletTransactionError('USER_REJECTED', 'rejected'); };
  await assert.rejects(r.controller.send(next)); assert.equal(r.controller.journal(id, 'deposit'), null);
});
test('borrower can claim a no-copy refund at the verified deadline even while held', async () => {
  const s = setup();
  s.request.status = 'REJECTED_NO_COPY';
  s.request.refundStatus = 'REFUND_DUE';
  s.request.approvalDeadline = 2;
  s.request.depositWei = fixture.policy.depositWei;
  s.accountStatus.held = true;
  await assert.rejects(s.controller.prepare(id, 'refund'), /ACTION_UNAVAILABLE/);
  s.accountStatus.checkedAt = 2;
  const call = await s.controller.prepare(id, 'refund'); assert.equal(call.amountWei, '0'); assert.equal(call.recipient, account);
  assert.equal(call.refundWei, fixture.policy.depositWei);
  s.request.refundStatus = 'REFUNDED';
  await assert.rejects(s.controller.prepare(id, 'refund'), /ACTION_UNAVAILABLE/);
});
test('server-known pending action blocks a fresh browser before any send', async () => {
  const s = setup(); s.request.transactions = [{ action: 'deposit', txHash: hash, status: 'SUBMITTED', submittedAt: 1, proof: null }];
  await assert.rejects(s.controller.prepare(id, 'deposit'), /RECOVERY_REQUIRED/); assert.equal(s.sends(), 0);
});
test('an old reverted receipt cannot unlock a later unknown send without hash', async () => {
  const s = setup(); s.request.transactions = [{ action: 'deposit', txHash: hash, status: 'REVERTED', submittedAt: 1, proof: null }];
  const call = await s.controller.prepare(id, 'deposit');
  s.wallet.sendTransactionWithGuard = async (_a, _tx, guard) => { guard(); throw new WalletTransactionError('SEND_OUTCOME_UNKNOWN', 'unknown'); };
  await assert.rejects(s.controller.send(call));
  await s.controller.reconcile(id, 'deposit'); assert.equal(s.controller.journal(id, 'deposit')?.phase, 'unknown');
  await assert.rejects(s.controller.reconcile(id, 'deposit', hash), /RECOVERY_REQUIRED/);
});
test('post-broadcast quota failure retains the known hash in the live controller and blocks resending', async () => {
  const s = setup(), call = await s.controller.prepare(id, 'deposit'); let writes = 0;
  const save = s.storage.setItem;
  s.storage.setItem = (key, value) => { if (++writes > 1) throw new Error('quota'); save(key, value); };
  await assert.rejects(s.controller.send(call), /STORAGE_BLOCKED/);
  assert.equal(s.controller.journal(id, 'deposit')?.hash, hash);
  assert.equal(s.controller.journal(id, 'deposit')?.phase, 'pending');
  assert.equal(new LibraryTransactions(s.options).journal(id, 'deposit')?.phase, 'unknown');
  await assert.rejects(s.controller.send(call), /RECOVERY_REQUIRED/);
});
test('reconcile and send share the action mutex, so late H1 recovery cannot erase unknown H2', async () => {
  const s = setup(); s.request.transactions = [{ action: 'deposit', txHash: hash, status: 'REVERTED', submittedAt: 1, proof: null }];
  const call = await s.controller.prepare(id, 'deposit');
  let tail = Promise.resolve();
  s.options.lock = (_key, run) => { const result = tail.then(run); tail = result.catch(() => {}); return result; };
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; });
  const original = s.options.api.getRequest.bind(s.options.api); let gate = true;
  s.options.api.getRequest = async key => { if (gate) { gate = false; entered(); await waiting; } return original(key); };
  const recovering = s.controller.reconcile(id, 'deposit'); await started;
  let sent = false;
  s.wallet.sendTransactionWithGuard = async (_a, _tx, guard) => { guard(); sent = true; throw new WalletTransactionError('SEND_OUTCOME_UNKNOWN', 'unknown'); };
  const sending = s.controller.send(call); const rejected = assert.rejects(sending, /SEND_OUTCOME_UNKNOWN/);
  await new Promise(done => setImmediate(done)); assert.equal(sent, false);
  release(); await recovering; await rejected;
  assert.equal(s.controller.journal(id, 'deposit')?.phase, 'unknown');
  await assert.rejects(s.controller.send(call), /RECOVERY_REQUIRED/);
});
test('another controller cannot overlay a newer attempt with a transient hash from its prior attempt', async () => {
  const s = setup(); const other = new LibraryTransactions(s.options);
  const first = await other.prepare(id, 'deposit');
  const save = s.storage.setItem; let writes = 0;
  s.storage.setItem = (key, value) => { if (++writes > 1) throw new Error('quota'); save(key, value); };
  await assert.rejects(other.send(first), /STORAGE_BLOCKED/); assert.equal(other.retainedHash(id, 'deposit'), hash);
  s.storage.setItem = save;
  // Another tab resolves H1, then crosses the broadcast boundary for H2 and loses its hash.
  s.request.transactions = [{ action: 'deposit', txHash: hash, status: 'REVERTED', submittedAt: 1, proof: null }];
  await s.controller.reconcile(id, 'deposit', hash);
  const second = await s.controller.prepare(id, 'deposit');
  s.wallet.sendTransactionWithGuard = async (_a, _tx, guard) => { guard(); throw new WalletTransactionError('SEND_OUTCOME_UNKNOWN', 'unknown'); };
  await assert.rejects(s.controller.send(second));
  assert.equal(other.journal(id, 'deposit')?.phase, 'unknown'); assert.equal(other.journal(id, 'deposit')?.hash, null);
  await other.reconcile(id, 'deposit'); assert.equal(s.controller.journal(id, 'deposit')?.phase, 'unknown');
  await assert.rejects(other.send(second), /RECOVERY_REQUIRED/);
});
