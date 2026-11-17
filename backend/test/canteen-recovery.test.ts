import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import express from 'express';
import { id } from 'ethers';
import type { AuthService } from '../src/modules/auth/auth.service.ts';
import type { LibraryAuthConfig } from '../src/modules/auth/auth.config.ts';
import type { LibraryService } from '../src/modules/library/library.service.ts';
import type { InvoiceCreationService } from '../src/modules/invoices/invoices.service.ts';
import type { ReceiptService } from '../src/modules/invoices/receipt.service.ts';
import type { GrantsService } from '../src/modules/grants/grants.service.ts';
import { CanteenRepository } from '../src/modules/canteen/canteen.repository.ts';
import { CanteenService } from '../src/modules/canteen/canteen.service.ts';
import { createCanteenRouter } from '../src/modules/canteen/canteen.routes.ts';

// HTTP/SQLite regression. RPC, receipt verification and account hold are fixture boundaries.
const manifest = JSON.parse(readFileSync(new URL('../../docs/fixtures/b03-l05-l06-local.json', import.meta.url), 'utf8')).manifest;
manifest.environment = 'avalanche-l1';
const wallet = `0x${'12'.repeat(20)}`;
const other = `0x${'34'.repeat(20)}`;
const hash = `0x${'ab'.repeat(32)}`;
const origin = 'http://localhost:3000';

async function fixture(prepared = true) {
  const repository = new CanteenRepository(':memory:');
  repository.seed();
  const initial = repository.create(wallet, 'held-recovery', 'WALLET', [{ dishId: 'com-tam', quantity: 1 }]);
  const order = prepared ? repository.prepare(initial.id, wallet, 10, id('held-recovery')) : initial;
  const proof = { invoiceId: order.invoiceId, payer: wallet, txHash: hash, merchant: manifest.merchants.canteen.address,
    category: id('FOOD'), originalAmount: order.totalWei, paidAmount: order.totalWei };
  const state = { receipt: { httpStatus: 200, body: { status: 'paid', receipt: proof } } as unknown,
    rpcError: false, receiptLookups: 0, invoiceCreations: 0 };
  const service = new CanteenService(repository, {
    manifest,
    rpc: { call: async (method: string) => {
      if (method === 'eth_getTransactionByHash') return { from: wallet, to: manifest.contracts.CampusPaymentRegistry.address,
        blockNumber: '0xb', value: `0x${BigInt(order.totalWei).toString(16)}` };
      if (method === 'eth_chainId') return '0x4f25';
      if (method === 'eth_getBlockByNumber') return { number: '0xb', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
      throw Error(`Unexpected RPC ${method}`);
    } },
    receipts: { lookup: async () => {
      state.receiptLookups++;
      if (state.rpcError) throw Error('RPC_UNAVAILABLE');
      return state.receipt;
    } } as unknown as ReceiptService,
    invoices: { createForService: async () => {
      state.invoiceCreations++;
      return { envelope: { invoice: { invoiceId: id('new-invoice') } } };
    } } as unknown as InvoiceCreationService,
    grants: {} as GrantsService,
  });
  const auth = { session: (token: string) => token === 'good' || token === 'other'
    ? { account: { wallet: token === 'good' ? wallet : other, role: 'STUDENT' } } : null } as unknown as AuthService;
  const app = express();
  app.use(createCanteenRouter(service, auth, { cookieName: 'session', origin } as LibraryAuthConfig,
    { accountStatus: async () => ({ held: true }) } as unknown as LibraryService));
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { repository, order, proof, state,
    post: (action: string, body: unknown = {}, token = 'good', requestOrigin = origin) =>
      fetch(`http://127.0.0.1:${address.port}/api/canteen/orders/${order.id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `session=${token}`, Origin: requestOrigin },
        body: JSON.stringify(body),
      }),
    close: async () => { await new Promise<void>(done => server.close(() => done())); repository.close(); },
  };
}

test('held owner recovers a paid WALLET order without its lost hash update or a new invoice', async () => {
  const f = await fixture();
  try {
    assert.equal(f.order.txHash, null);
    const response = await f.post('prepare');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.order.status, 'PAID');
    assert.equal(result.order.txHash, hash);
    assert.equal(result.order.invoiceId, f.order.invoiceId);
    assert.equal(result.envelope, null);
    assert.equal(f.state.invoiceCreations, 0);
    assert.ok(f.state.receiptLookups > 0);
    const verifiedLookups = f.state.receiptLookups;
    const repeated = await f.post('prepare');
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), result);
    assert.equal(f.state.receiptLookups, verifiedLookups);
  } finally { await f.close(); }
});

test('held wallet cannot prepare a new invoice, even with a forged paid hint', async () => {
  const f = await fixture(false);
  try {
    const response = await f.post('prepare');
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'ACCOUNT_HELD');
    assert.equal(f.state.invoiceCreations, 0);
    assert.equal(f.state.receiptLookups, 0);
    assert.equal(f.repository.get(f.order.id, wallet).txHash, null);
  } finally { await f.close(); }
});

for (const status of ['pending', 'issued', 'rpc-error']) {
  test(`held ${status} order stays unverified and cannot prepare another payment`, async () => {
    const f = await fixture();
    try {
      f.state.receipt = { httpStatus: status === 'rpc-error' ? 503 : 200, body: { status, receipt: null } };
      const response = await f.post('prepare');
      assert.equal(response.status, 403);
      assert.equal(f.repository.get(f.order.id, wallet).status, 'AWAITING_PAYMENT');
      assert.equal(f.repository.get(f.order.id, wallet).invoiceId, f.order.invoiceId);
      assert.equal(f.state.invoiceCreations, 0);
    } finally { await f.close(); }
  });
}

test('recovery RPC failure never changes the order or creates an invoice', async () => {
  const f = await fixture();
  try {
    f.state.rpcError = true;
    assert.equal((await f.post('prepare')).status, 503);
    assert.equal(f.repository.get(f.order.id, wallet).status, 'AWAITING_PAYMENT');
    assert.equal(f.state.invoiceCreations, 0);
  } finally { await f.close(); }
});

test('recovery preserves session, ownership, Origin and body validation before receipt lookup', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('prepare', {}, 'invalid')).status, 401);
    assert.equal((await f.post('prepare', {}, 'other')).status, 404);
    assert.equal((await f.post('prepare', {}, 'good', 'http://evil.test')).status, 403);
    assert.equal((await f.post('prepare', { txHash: hash })).status, 400);
    assert.equal(f.state.receiptLookups, 0);
    assert.equal(f.state.invoiceCreations, 0);
  } finally { await f.close(); }
});

test('a mismatched paid proof never marks the held order paid', async () => {
  const f = await fixture();
  try {
    f.state.receipt = { httpStatus: 200, body: { status: 'paid', receipt: { ...f.proof, payer: other } } };
    assert.equal((await f.post('prepare')).status, 422);
    assert.equal(f.repository.get(f.order.id, wallet).status, 'AWAITING_PAYMENT');
    assert.equal(f.state.invoiceCreations, 0);
  } finally { await f.close(); }
});
