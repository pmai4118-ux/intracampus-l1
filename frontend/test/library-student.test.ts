import assert from 'node:assert/strict';
import test from 'node:test';
import { LibraryApi, parseLibraryBook, parseLibraryRequest, parseLibraryUnmatchedDeposit } from '../lib/library-api.ts';
import { libraryError, libraryRecoveryDetails, unmatchedRecoveryAllowed, libraryBalance } from '../lib/library.ts';
import { WalletTransactionError } from '../lib/wallet.ts';
import type { LibraryJournal } from '../lib/library-transactions.ts';

const id = `0x${'ab'.repeat(32)}`;
test('library balance preview keeps bigint precision and marks truncated digits', () => {
  assert.deepEqual(libraryBalance(BigInt(0)), { label: '0 CAMPUS', approximate: false });
  assert.deepEqual(libraryBalance(BigInt(1)), { label: '0 CAMPUS', approximate: true });
  assert.deepEqual(libraryBalance(BigInt('123456789012345678901234567890')), { label: '123.456.789.012,3456 CAMPUS', approximate: true });
  assert.deepEqual(libraryBalance(BigInt('1234500000000000000')), { label: '1,2345 CAMPUS', approximate: false });
});
const pendingRequest = { requestId: id, bookId: id, status: 'PENDING_APPROVAL', refundStatus: 'NONE', depositWei: '50000000000000000000',
  depositIntent: null, approvalDeadline: 1800000000, loanId: null, transactions: [], createdAt: 1, updatedAt: 1 };

test('an unmatched refund proof must come from the same escrow as its deposit', () => {
  const borrower = `0x${'22'.repeat(20)}`;
  const escrow = `0x${'33'.repeat(20)}`;
  const proof = { chainId: 20261, contractAddress: escrow, requestId: id, txHash: id, borrower,
    blockHash: id, blockNumber: 1, logIndex: 0, eventName: 'DepositReceived' };
  const deposit = { requestId: id, bookId: id, borrower, amountWei: '50000000000000000000', approvalDeadline: 1800000000,
    depositProof: proof, refundProof: { ...proof, eventName: 'ExpiredRefundClaimed' }, latestEvent: 'ExpiredRefundClaimed', refundIntent: null };
  assert.equal(parseLibraryUnmatchedDeposit(deposit).refundProof?.contractAddress, escrow);
  assert.throws(() => parseLibraryUnmatchedDeposit({ ...deposit, refundProof: { ...deposit.refundProof, contractAddress: borrower } }), /INVALID_RESPONSE/);
});

test('refusing a transaction is distinguished from refusing sign-in', () => {
  assert.match(libraryError(new WalletTransactionError('SIGNATURE_REJECTED', 'rejected', 'transaction')), /từ chối giao dịch/);
  assert.match(libraryError(new WalletTransactionError('SIGNATURE_REJECTED', 'rejected', 'message')), /ký đăng nhập/);
});
test('catalog parser preserves exact wei and rejects malformed quantities', () => {
  const book = { bookId: id, title: 'Sách', author: 'Tác giả', isbn: null, depositWei: '50000000000000000000', replacementPriceWei: '90071992547409930000', copiesTotal: 2, copiesAvailable: 1 };
  assert.equal(parseLibraryBook(book).replacementPriceWei, book.replacementPriceWei);
  for (const depositWei of [50, '-1', '1.2', '01', '1e18']) assert.throws(() => parseLibraryBook({ ...book, depositWei }));
});
test('deposit confirmation stays pending approval; malformed state is rejected', () => {
  assert.equal(parseLibraryRequest(pendingRequest).loanId, null);
  assert.throws(() => parseLibraryRequest({ ...pendingRequest, status: 'ACTIVE' }));
  assert.throws(() => parseLibraryRequest({ ...pendingRequest, depositConflict: { requestId: id } }), /INVALID_RESPONSE/);
});
test('tracking is bound to the requested ID', async () => {
  const otherId = `0x${'01'.repeat(32)}`;
  const api = new LibraryApi(async () => Response.json({ request: { ...pendingRequest, requestId: otherId } }));
  await assert.rejects(api.track(id, 'deposit', id), /INVALID_RESPONSE/);
});

test('tracking retains the winning proof and adds the exact reverted attempt', async () => {
  const other = `0x${'cd'.repeat(32)}`;
  const wallet = `0x${'22'.repeat(20)}`;
  const winner = { action: 'refund', txHash: id, status: 'CONFIRMED', submittedAt: 1, proof: { chainId: 20261, contractAddress: wallet,
    requestId: id, txHash: id, borrower: wallet, blockHash: id, blockNumber: 1, logIndex: 0, eventName: 'ExpiredRefundClaimed' } };
  const loser = { action: 'refund', txHash: other, status: 'REVERTED', submittedAt: 2, proof: null };
  const api = new LibraryApi(async () => Response.json({ request: { ...pendingRequest, transactions: [winner] }, transaction: loser }));
  const tracked = await api.track(id, 'refund', other);
  assert.equal(tracked.transactions[0].txHash, id);
  assert.equal(tracked.transactions.find(t => t.txHash === other)?.status, 'REVERTED');
});
test('a confirmed transaction requires the event for its own action', () => {
  const wallet = `0x${'22'.repeat(20)}`;
  const tx = { action: 'deposit', txHash: id, status: 'CONFIRMED', submittedAt: 1, proof: { chainId: 20261, contractAddress: wallet,
    requestId: id, txHash: id, borrower: wallet, blockHash: id, blockNumber: 1, logIndex: 0, eventName: 'LoanApproved' } };
  assert.throws(() => parseLibraryRequest({ ...pendingRequest, transactions: [tx] }), /INVALID_RESPONSE/);
  assert.equal(parseLibraryRequest({ ...pendingRequest, transactions: [{ ...tx, proof: { ...tx.proof, eventName: 'DepositReceived' } }] }).transactions.length, 1);
});
test('recovery never displays the previous receipt status against a new pending hash', () => {
  const newHash = `0x${'cd'.repeat(32)}`;
  const request = parseLibraryRequest({ ...pendingRequest, transactions: [
    { action: 'deposit', txHash: id, status: 'REVERTED', submittedAt: 1, proof: null },
  ] });
  const record: LibraryJournal = { version: 1, attemptId: 'second', requestId: id, action: 'deposit',
    account: 'test-account', deployment: 'test-deployment', phase: 'pending', hash: newHash, previousHash: id };
  assert.deepEqual(libraryRecoveryDetails(record, request.transactions[0]), { hash: newHash, matchedTx: undefined });
  assert.equal(libraryRecoveryDetails({ ...record, hash: id }, request.transactions[0]).matchedTx?.status, 'REVERTED');
});
test('an old refund receipt cannot resolve a newer unmatched deposit attempt', () => {
  const pending = `0x${'cd'.repeat(32)}`;
  assert.equal(unmatchedRecoveryAllowed({ phase: 'pending', hash: pending }, id), false);
  assert.equal(unmatchedRecoveryAllowed({ phase: 'pending', hash: pending }, pending), true);
  assert.equal(unmatchedRecoveryAllowed({ phase: 'unknown', hash: null, previousHashes: [id] }, id), false);
  assert.equal(unmatchedRecoveryAllowed({ phase: 'unknown', hash: null, previousHashes: [id] }, pending), true);
});
test('API uses same origin cookies and encodes search, surfacing retry-after', async () => {
  const api = new LibraryApi(async (path, init) => {
    assert.equal(path, '/api/library/books?q=A%26B');
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store');
    return new Response(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), { status: 429, headers: { 'retry-after': '7' } });
  });
  await assert.rejects(api.books('A&B'), (e: any) => e.code === 'RATE_LIMITED' && e.retryAfterSeconds === 7);
});
test('API calls a native-style fetch without rebinding its receiver', async () => {
  const api = new LibraryApi(function (this: unknown) { assert.equal(this, undefined); return Promise.resolve(Response.json([])); });
  assert.deepEqual(await api.books(), []);
});
