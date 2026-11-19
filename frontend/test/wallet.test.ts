import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interface, Signature, verifyMessage, Wallet } from 'ethers';
import { WalletController, WalletTransactionError, selectInjectedWallet, type WalletProvider, type WalletRpc } from '../lib/wallet.ts';
import { formatWalletBalance, formatWalletBalanceCompact, validateWalletConfig, walletChainParameters } from '../lib/chains.ts';

const A = `0x${'11'.repeat(20)}`, B = `0x${'22'.repeat(20)}`, SBT = `0x${'33'.repeat(20)}`;
const config = { rpcUrl: 'https://rpc.example', sbtAddress: SBT };
const abi = new Interface(['function tierOf(address) view returns (uint8)', 'function credentials(address) view returns (uint256,uint64)']);
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
};
class Provider implements WalletProvider {
  accounts = [A]; chain = '0x4f25'; calls: string[] = [];
  reject?: number; unknownChain = false; switchChanges = true;
  connectPending?: Promise<unknown>;
  switchPending?: Promise<unknown>;
  chainPending?: Promise<unknown>;
  signPending?: Promise<unknown>;
  signature = `0x${'ab'.repeat(65)}`;
  signingAccount = A;
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    this.calls.push(method);
    if (method === 'eth_chainId') return this.chainPending ?? this.chain;
    if (method === 'eth_accounts') return [...this.accounts];
    if (method === 'eth_requestAccounts') {
      if (this.reject) throw { code: this.reject };
      return this.connectPending ?? [...this.accounts];
    }
    if (method === 'personal_sign') {
      assert.equal(typeof params?.[0], 'string');
      assert.equal(params?.[1], this.signingAccount);
      if (this.reject) throw { code: this.reject };
      return this.signPending ?? this.signature;
    }
    if (method === 'eth_sendTransaction') {
      assert.equal((params?.[0] as { from?: string } | undefined)?.from, this.signingAccount);
      if (this.reject) throw { code: this.reject };
      return `0x${'cd'.repeat(32)}`;
    }
    if (method === 'wallet_switchEthereumChain') {
      assert.deepEqual(params, [{ chainId: '0x4f25' }]);
      if (this.reject) throw { code: this.reject };
      if (this.unknownChain) throw { code: 4902 };
      if (this.switchPending) return this.switchPending;
      if (this.switchChanges) this.chain = '0x4f25';
      return null;
    }
    if (method === 'wallet_addEthereumChain') {
      assert.deepEqual(params, [{ chainId: '0x4f25', chainName: 'IntraCampus L1',
        nativeCurrency: { name: 'Campus', symbol: 'CAMPUS', decimals: 18 }, rpcUrls: ['https://rpc.example'] }]);
      this.unknownChain = false; return null;
    }
    throw new Error(`Unexpected wallet method ${method}`);
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string, value?: unknown) { for (const fn of this.listeners.get(event) ?? []) fn(value); }
}
class Rpc {
  chain = '0x4f25'; fail = false; timestamp = 100;
  tier = 1; tokenId = 1; expiry = 100;
  balances = new Map([[A, '0x0'], [B, '0x1']]);
  pendingA?: Promise<unknown>;
  badTier?: string; badCredential?: string;
  calls: string[] = [];
  call: WalletRpc = async (method, params) => {
    this.calls.push(method);
    if (this.fail) throw new Error('RPC unavailable');
    if (method === 'eth_chainId') return this.chain;
    if (method === 'eth_getBlockByNumber') return { number: '0x10', timestamp: hex(this.timestamp) };
    assert.equal(params[1], '0x10');
    if (method === 'eth_getBalance') return params[0] === A && this.pendingA ? this.pendingA : this.balances.get(params[0] as string);
    if (method === 'eth_call') {
      const request = params[0] as { to: string; data: string };
      assert.equal(request.to, SBT);
      const fn = abi.parseTransaction({ data: request.data }); assert.ok(fn);
      assert.ok([A, B].includes(fn.args[0].toLowerCase()) || this.balances.has(fn.args[0].toLowerCase()));
      if (fn.name === 'tierOf') return this.badTier ?? abi.encodeFunctionResult('tierOf', [this.tier]);
      return this.badCredential ?? abi.encodeFunctionResult('credentials', [this.tokenId, this.expiry]);
    }
    throw new Error(`Unexpected RPC method ${method}`);
  };
}
function setup() {
  const provider = new Provider(), rpc = new Rpc();
  const c = new WalletController({ provider, config, rpc: rpc.call });
  return { provider, rpc, c };
}
test('Core direct provider is preferred to a conflicting ethereum injection', async () => {
  const core = new Provider(), other = new Provider();
  assert.equal(selectInjectedWallet({ avalanche: core, ethereum: other }), core);
  assert.equal(selectInjectedWallet({ avalanche: {}, ethereum: other }), other);
  assert.equal(selectInjectedWallet({ ethereum: other }), other);
  assert.equal(selectInjectedWallet({ avalanche: {}, ethereum: {} }), undefined);
  assert.equal(await selectInjectedWallet({ avalanche: core })!.request({ method: 'eth_chainId' }), '0x4f25');
});
async function waitFor(c: WalletController, predicate: () => boolean) {
  if (predicate()) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(new Error('State did not settle')); }, 1000);
    const poll = setInterval(() => { if (predicate()) { clearTimeout(timeout); clearInterval(poll); resolve(); } }, 1);
  });
}

test('missing provider cannot authorize payment', async () => {
  const c = new WalletController({ config: {} }); await c.start();
  assert.equal(c.getSnapshot().status, 'no-wallet'); assert.equal(c.getSnapshot().canProceed, false); c.dispose();
});
test('reads actual zero balance and tier1 at inclusive chain expiry using L03 ABI', async () => {
  const { c, provider } = setup(); await c.connect(); const s = c.getSnapshot();
  assert.equal(s.status, 'ready'); assert.equal(s.address, A); assert.equal(s.balanceWei, BigInt(0));
  assert.equal(s.card.tier, 1); assert.equal(s.card.status, 'valid'); assert.equal(s.card.expiresAt, BigInt(100));
  assert.equal(s.canProceed, true); assert.ok(!provider.calls.some((m) => /sign|send/i.test(m))); c.dispose();
});
test('message signing uses UTF-8 personal_sign and rechecks selected wallet and chain', async (t) => {
  const { c, provider } = setup(); t.after(() => c.dispose()); await c.connect();
  const message = 'IntraCampus Library session · 2026';
  const expectedData = `0x${Array.from(new TextEncoder().encode(message), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const originalRequest = provider.request.bind(provider);
  provider.request = async (args) => {
    if (args.method === 'personal_sign') assert.equal(args.params?.[0], expectedData);
    return originalRequest(args);
  };
  assert.equal(await c.signMessage(A, message), provider.signature);

  await assert.rejects(c.signMessage(B, message), (error: unknown) =>
    error instanceof WalletTransactionError && error.code === 'WALLET_SESSION_CHANGED');
  provider.chain = '0x1';
  await assert.rejects(c.signMessage(A, message), (error: unknown) =>
    error instanceof WalletTransactionError && error.code === 'WRONG_CHAIN');
});
test('Core signing receives the checksummed account after state normalizes it for comparisons', async (t) => {
  const signer = new Wallet(`0x${'12'.repeat(32)}`);
  const { c, provider, rpc } = setup(); t.after(() => c.dispose());
  provider.accounts = [signer.address]; provider.signingAccount = signer.address;
  rpc.balances.set(signer.address.toLowerCase(), '0x0');
  await c.connect();
  assert.equal(c.getSnapshot().address, signer.address.toLowerCase());
  await c.signMessage(signer.address.toLowerCase(), 'Library login');
});
test('message signing accepts a valid compact 64-byte Ethereum signature', async (t) => {
  const signer = new Wallet(`0x${'11'.repeat(32)}`);
  const message = 'IntraCampus Library compact signature';
  const signature = Signature.from(await signer.signMessage(message)).compactSerialized;
  assert.equal((signature.length - 2) / 2, 64);
  assert.equal(verifyMessage(message, signature).toLowerCase(), signer.address.toLowerCase());

  const { c, provider } = setup(); t.after(() => c.dispose()); await c.connect();
  provider.accounts = [signer.address];
  provider.signingAccount = signer.address;
  provider.signature = signature;
  const mutableController = c as unknown as { state: ReturnType<WalletController['getSnapshot']> };
  mutableController.state = { ...c.getSnapshot(), address: signer.address, accounts: [signer.address.toLowerCase()] };

  assert.equal(await c.signMessage(signer.address, message), signature);
});

test('message signing preserves only the numeric provider error for diagnostics', async (t) => {
  const { c, provider } = setup(); t.after(() => c.dispose()); await c.connect();
  const original = provider.request.bind(provider);
  provider.request = async args => {
    if (args.method === 'personal_sign') throw { code: -32603, message: 'private wallet details' };
    return original(args);
  };
  await assert.rejects(c.signMessage(A, 'Library login'), (error: unknown) =>
    error instanceof WalletTransactionError && error.providerCode === -32603
      && error.code === 'WALLET_UNAVAILABLE' && !error.message.includes('private'));
});
test('account changes while the user approves a message discard that signature', async (t) => {
  const { c, provider } = setup(); t.after(() => c.dispose()); await c.connect();
  const pending = deferred(); provider.signPending = pending.promise;
  const signing = c.signMessage(A, 'sign-in');
  await new Promise((resolve) => setImmediate(resolve));
  provider.accounts = [B]; provider.emit('accountsChanged', [B]);
  await waitFor(c, () => c.getSnapshot().address === B && c.getSnapshot().status === 'ready');
  pending.resolve(provider.signature);
  await assert.rejects(signing, (error: unknown) =>
    error instanceof WalletTransactionError && error.code === 'WALLET_SESSION_CHANGED');
});
test('Core transactions receive the checksummed from account after state normalization', async (t) => {
  const signer = new Wallet(`0x${'21'.repeat(32)}`);
  const { c, provider, rpc } = setup(); t.after(() => c.dispose());
  provider.accounts = [signer.address]; provider.signingAccount = signer.address;
  rpc.balances.set(signer.address.toLowerCase(), '0x0');
  await c.connect();
  assert.equal(c.getSnapshot().address, signer.address.toLowerCase());
  assert.equal(await c.sendTransaction(signer.address.toLowerCase(), { to: B, data: '0x1234', value: '0x0' }), `0x${'cd'.repeat(32)}`);
});
for (const scenario of [
  { tier: 0, tokenId: 0, expiry: 0, status: 'none' },
  { tier: 0, tokenId: 1, expiry: 99, status: 'expired' },
  { tier: 0, tokenId: 1, expiry: 200, status: 'inactive' },
]) test(`card ${scenario.status} is derived from credentials plus effective tier`, async () => {
  const { c, rpc } = setup(); Object.assign(rpc, scenario); await c.start();
  assert.equal(c.getSnapshot().card.status, scenario.status); assert.equal(c.getSnapshot().card.tier, 0); c.dispose();
});
test('accountsChanged clears previous data immediately and loads second wallet', async () => {
  const { c, provider, rpc } = setup(); await c.start();
  rpc.tier = 0; rpc.tokenId = 0; rpc.expiry = 0; provider.accounts = [B]; provider.emit('accountsChanged', [B]);
  assert.equal(c.getSnapshot().balanceWei, null); assert.equal(c.getSnapshot().canProceed, false);
  await waitFor(c, () => c.getSnapshot().status === 'ready');
  assert.equal(c.getSnapshot().address, B); assert.equal(c.getSnapshot().balanceWei, BigInt(1));
  assert.equal(c.getSnapshot().card.tier, 0); c.dispose();
});
test('late old RPC balance cannot overwrite a newly selected account', async () => {
  const { c, provider, rpc } = setup(); const pending = deferred(); rpc.pendingA = pending.promise;
  const old = c.start(); await waitFor(c, () => rpc.calls.includes('eth_getBalance'));
  provider.accounts = [B]; provider.emit('accountsChanged', [B]);
  await waitFor(c, () => c.getSnapshot().status === 'ready');
  pending.resolve('0xffff'); await old;
  assert.equal(c.getSnapshot().address, B); assert.equal(c.getSnapshot().balanceWei, BigInt(1)); c.dispose();
});
test('late connect permission response cannot overwrite accountsChanged', async () => {
  const { c, provider } = setup(); const pending = deferred(); provider.connectPending = pending.promise;
  const old = c.connect(); provider.accounts = [B]; provider.emit('accountsChanged', [B]);
  await waitFor(c, () => c.getSnapshot().status === 'ready'); pending.resolve([A]); await old;
  assert.equal(c.getSnapshot().address, B); c.dispose();
});
test('wrong wallet chain does not read trusted RPC or enable payment', async () => {
  const { c, provider, rpc } = setup(); provider.chain = '0xa869'; await c.start();
  assert.equal(c.getSnapshot().status, 'wrong-chain'); assert.equal(c.getSnapshot().balanceWei, null);
  assert.deepEqual(rpc.calls, []); assert.equal(c.getSnapshot().canProceed, false); c.dispose();
});
test('switch success is confirmed by rereading wallet chain', async () => {
  const { c, provider } = setup(); provider.chain = '0xa869'; await c.start(); await c.switchNetwork();
  assert.equal(c.getSnapshot().status, 'ready'); assert.equal(c.getSnapshot().chainId, BigInt(20261)); c.dispose();
});
test('wallet reports switch success but unchanged chain remains blocked', async () => {
  const { c, provider } = setup(); provider.chain = '0xa869'; provider.switchChanges = false;
  await c.start(); await c.switchNetwork(); assert.equal(c.getSnapshot().status, 'wrong-chain');
  assert.equal(c.getSnapshot().canProceed, false); c.dispose();
});
test('4902 adds only trusted network configuration then switches and verifies', async () => {
  const { c, provider } = setup(); provider.chain = '0xa869'; provider.unknownChain = true;
  await c.start(); await c.switchNetwork(); assert.equal(c.getSnapshot().status, 'ready');
  assert.ok(provider.calls.includes('wallet_addEthereumChain')); c.dispose();
});
test('user rejects network switch and stays blocked with useful message', async () => {
  const { c, provider } = setup(); provider.chain = '0xa869'; provider.reject = 4001;
  await c.start(); await c.switchNetwork(); assert.equal(c.getSnapshot().status, 'wrong-chain');
  assert.match(c.getSnapshot().message!, /từ chối/); assert.equal(c.getSnapshot().canProceed, false); c.dispose();
});
for (const code of [4001, -32002]) test(`wallet connection error ${code} remains retryable by user`, async () => {
  const { c, provider } = setup(); provider.reject = code; await c.connect();
  assert.equal(c.getSnapshot().status, code === 4001 ? 'rejected' : 'rpc-error');
  assert.equal(c.getSnapshot().canProceed, false); provider.reject = undefined; await c.connect();
  assert.equal(c.getSnapshot().status, 'ready'); c.dispose();
});
test('RPC outage clears prior quote eligibility and retry restores verified state', async () => {
  const { c, rpc } = setup(); await c.start(); rpc.fail = true; await c.refresh();
  assert.equal(c.getSnapshot().status, 'rpc-error'); assert.equal(c.getSnapshot().balanceWei, null);
  assert.equal(c.getSnapshot().card.tier, null); assert.equal(c.getSnapshot().canProceed, false);
  rpc.fail = false; await c.refresh(); assert.equal(c.getSnapshot().status, 'ready'); c.dispose();
});
test('trusted RPC wrong chain is blocked even when wallet is on campus', async () => {
  const { c, rpc } = setup(); rpc.chain = '0xa869'; await c.start();
  assert.equal(c.getSnapshot().status, 'rpc-error'); assert.equal(c.getSnapshot().card.tier, null); c.dispose();
});
for (const missing of ['rpcUrl', 'sbtAddress'] as const) test(`missing ${missing} never implies tier0`, async () => {
  const provider = new Provider(), rpc = new Rpc();
  const c = new WalletController({ provider, config: { ...config, [missing]: undefined }, rpc: rpc.call });
  await c.start(); assert.equal(c.getSnapshot().status, 'config-missing');
  assert.equal(c.getSnapshot().card.tier, null); assert.equal(c.getSnapshot().canProceed, false);
  assert.equal(c.getSnapshot().balanceWei, missing === 'rpcUrl' ? null : BigInt(0)); c.dispose();
});
for (const mode of ['bad-tier', 'bad-credentials', 'unsupported-tier', 'inconsistent-expiry'] as const) test(`rejects SBT ${mode}`, async () => {
  const { c, rpc } = setup();
  if (mode === 'bad-tier') rpc.badTier = '0x01';
  if (mode === 'bad-credentials') rpc.badCredential = '0x';
  if (mode === 'unsupported-tier') rpc.tier = 2;
  if (mode === 'inconsistent-expiry') rpc.expiry = 99;
  await c.start(); assert.equal(c.getSnapshot().status, 'rpc-error');
  assert.equal(c.getSnapshot().card.tier, null); assert.equal(c.getSnapshot().canProceed, false); c.dispose();
});
test('empty account event disconnects and pending reads cannot restore session', async () => {
  const { c, provider, rpc } = setup(); const pending = deferred(); rpc.pendingA = pending.promise;
  const old = c.start(); await waitFor(c, () => rpc.calls.includes('eth_getBalance'));
  provider.accounts = []; provider.emit('accountsChanged', []);
  await waitFor(c, () => c.getSnapshot().status === 'disconnected'); pending.resolve('0x123'); await old;
  assert.equal(c.getSnapshot().address, null); assert.equal(c.getSnapshot().balanceWei, null); c.dispose();
});
test('dispose removes exact listeners and ignores late RPC', async () => {
  const { c, provider, rpc } = setup(); const pending = deferred(); rpc.pendingA = pending.promise;
  const old = c.start(); await waitFor(c, () => rpc.calls.includes('eth_getBalance'));
  c.dispose(); const state = c.getSnapshot(); pending.resolve('0xff'); await old;
  assert.strictEqual(c.getSnapshot(), state); assert.equal([...provider.listeners.values()].flatMap((s) => [...s]).length, 0);
});
test('explicit local disconnect stays disconnected until connect is pressed', async () => {
  const { c, provider } = setup(); await c.start(); c.disconnect();
  provider.emit('chainChanged', '0x4f25'); await new Promise((done) => setTimeout(done, 10));
  assert.equal(c.getSnapshot().status, 'disconnected'); assert.equal(c.getSnapshot().address, null);
  await c.connect(); assert.equal(c.getSnapshot().status, 'ready'); c.dispose();
});
test('integer formatting preserves one wei and large balances', () => {
  assert.equal(formatWalletBalance(BigInt(0)), '0 CAMPUS');
  assert.equal(formatWalletBalance(BigInt(1)), '0,000000000000000001 CAMPUS');
  assert.equal(formatWalletBalance(BigInt('3000000000000000000001')), '3.000,000000000000000001 CAMPUS');
  assert.deepEqual(formatWalletBalanceCompact(BigInt('3000000000000000000000')), {
    display: '3.000 CAMPUS', exact: '3.000 CAMPUS', rounded: false,
  });
  assert.deepEqual(formatWalletBalanceCompact(BigInt('9999998908579500000000')), {
    display: '9.999,99 CAMPUS', exact: '9.999,9989085795 CAMPUS', rounded: true,
  });
});
test('network configuration rejects unsafe or malformed public values', () => {
  for (const rpcUrl of ['http://public.example', 'https://user:secret@rpc.example', 'file:///tmp/x']) assert.throws(() => validateWalletConfig({ rpcUrl }));
  assert.throws(() => validateWalletConfig({ sbtAddress: `0x${'0'.repeat(40)}` }));
  assert.throws(() => validateWalletConfig({ paymentRegistryAddress: '0xnot-an-address' }));
  assert.throws(() => validateWalletConfig({ posSignerAddress: `0x${'0'.repeat(40)}` }));
  assert.throws(() => walletChainParameters({}));
  assert.equal(walletChainParameters({ rpcUrl: 'http://127.0.0.1:8545' }).chainId, '0x4f25');
});

test('pending network switch cannot reconnect an explicitly disconnected session', async () => {
  const { c, provider } = setup(); provider.chain = '0xa869'; await c.start();
  const pending = deferred(); provider.switchPending = pending.promise;
  const old = c.switchNetwork(); c.disconnect(); pending.resolve(null); await old;
  assert.equal(c.getSnapshot().status, 'disconnected'); assert.equal(c.getSnapshot().canProceed, false); c.dispose();
});
test('switching away from campus immediately clears verified values', async () => {
  const { c, provider } = setup(); await c.start();
  provider.chain = '0xa869'; provider.emit('chainChanged', provider.chain);
  assert.equal(c.getSnapshot().card.tier, null); assert.equal(c.getSnapshot().canProceed, false);
  await waitFor(c, () => c.getSnapshot().status === 'wrong-chain'); c.dispose();
});
test('multiple permitted accounts are selectable without another wallet authorization', async () => {
  const { c, provider } = setup(); provider.accounts = [A, B]; await c.start();
  await c.selectAccount(B); assert.equal(c.getSnapshot().address, B);
  assert.equal(c.getSnapshot().balanceWei, BigInt(1));
  assert.ok(!provider.calls.includes('eth_requestAccounts')); c.dispose();
});
test('malformed account event cannot preserve previously verified data', async () => {
  const { c, provider } = setup(); await c.start(); provider.emit('accountsChanged', ['not-an-address']);
  assert.equal(c.getSnapshot().status, 'rpc-error'); assert.equal(c.getSnapshot().address, null);
  assert.equal(c.getSnapshot().canProceed, false); c.dispose();
});

test('stale network rejection cannot write a warning into a disconnected session', async () => {
  const { c, provider } = setup(); provider.chain = '0xa869'; await c.start();
  const pending = deferred(); provider.chainPending = pending.promise; provider.reject = 4001;
  const old = c.switchNetwork();
  await waitFor(c, () => provider.calls.filter((method) => method === 'eth_chainId').length >= 2);
  c.disconnect(); pending.resolve('0xa869'); await old;
  assert.equal(c.getSnapshot().status, 'disconnected'); assert.equal(c.getSnapshot().message, null); c.dispose();
});
