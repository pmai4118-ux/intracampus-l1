import assert from 'node:assert/strict';
import test from 'node:test';
import { LibraryApi, parseLibraryBook, parseLibraryRequest } from '../lib/library-api.ts';

const id = `0x${'ab'.repeat(32)}`;
test('catalog parser preserves exact wei and rejects malformed quantities', () => {
  const book = { bookId: id, title: 'Sách', author: 'Tác giả', isbn: null, depositWei: '50000000000000000000', replacementPriceWei: '90071992547409930000', copiesTotal: 2, copiesAvailable: 1 };
  assert.equal(parseLibraryBook(book).replacementPriceWei, book.replacementPriceWei);
  for (const depositWei of [50, '-1', '1.2', '01', '1e18']) assert.throws(() => parseLibraryBook({ ...book, depositWei }));
});
test('deposit confirmation stays pending approval; malformed state is rejected', () => {
  const request = { requestId: id, bookId: id, status: 'PENDING_APPROVAL', refundStatus: 'NONE', depositWei: '50000000000000000000', depositIntent: null, approvalDeadline: 1800000000, loanId: null, transactions: [], createdAt: 1, updatedAt: 1 };
  assert.equal(parseLibraryRequest(request).loanId, null);
  assert.throws(() => parseLibraryRequest({ ...request, status: 'ACTIVE' }));
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
