// Opt-in acceptance on a disposable source copy, fresh SQLite, and a dedicated Anvil.
// Usage: node frontend/test/library-student-pilot.mjs <pilot-copy> <artifacts-dir> <playwright-dir>
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ContractFactory, JsonRpcProvider, keccak256, id } from 'ethers';

const [workspace, artifactsDir, playwrightDir] = process.argv.slice(2).map(p => resolve(p));
assert.ok(workspace.includes('.cross-review'), 'Run against a disposable copy, never the task checkout');
const rpcUrl = process.env.LIBRARY_ANVIL_URL;
assert.equal(process.env.LIBRARY_PILOT_ISOLATED, 'true');
assert.match(rpcUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
const evidenceDir = resolve(workspace, '../student-pilot-evidence'); mkdirSync(evidenceDir, { recursive: true });
const origin = 'http://127.0.0.1:3129';
const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 }); provider.pollingInterval = 50;
assert.match(await provider.send('web3_clientVersion', []), /anvil/i); assert.equal((await provider.getNetwork()).chainId, 20261n);
const importFrom = p => import(pathToFileURL(join(workspace, p)).href);
// Import existing invoice consumers before replacing the disposable copy's unconfigured manifest.
const { createApp } = await importFrom('backend/src/app.ts');
const fixture = JSON.parse(readFileSync(join(workspace, 'docs/fixtures/library-v1.json')));
const signers = await Promise.all(Array.from({ length: 7 }, (_, i) => provider.getSigner(i)));
const accounts = await Promise.all(signers.map(s => s.getAddress()));
const contracts = {};
async function deploy(name, args) {
  const artifact = JSON.parse(readFileSync(join(artifactsDir, `${name}.sol`, `${name}.json`)));
  const c = await new ContractFactory(artifact.abi, artifact.bytecode.object, signers[0]).deploy(...args);
  const receipt = await c.deploymentTransaction().wait();
  contracts[name] = { address: await c.getAddress(), abiVersion: 1, abi: artifact.abi, transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, runtimeCodeHash: keccak256(await provider.getCode(await c.getAddress())) };
  return c;
}
let apiServer, next, browser, repository, service;
const cases = [], errors = [], sends = [];
function record(name) { cases.push(name); console.log(`PASS ${name}`); }
try {
  const sbt = await deploy('StudentSBTIdentity', [accounts[0]]);
  const registry = await deploy('CampusPaymentRegistry', [accounts[0], accounts[1], await sbt.getAddress()]);
  await deploy('PurposeBoundGrantVault', [accounts[0], await registry.getAddress()]);
  const escrow = await deploy('LibraryDepositEscrow', [accounts[0], accounts[1], accounts[2]]);
  const seedTransactions = [], prices = ['30000000000000000000','80000000000000000000','50000000000000000000'];
  const titles = ['Lập trình căn bản','Cấu trúc dữ liệu','Mạng máy tính'];
  const books = [];
  for (let i = 0; i < prices.length; i++) {
    const bookId = id(`n471-pilot-${i}`); books.push({ bookId, depositWei: fixture.policy.depositWei, replacementPriceWei: prices[i], sealed: true });
    for (const [type, tx] of [['seedBookTerms', await escrow.seedBookTerms(bookId, fixture.policy.depositWei, prices[i])], ['sealBookTerms', null]]) {
      const receipt = await (tx ?? await escrow.sealBookTerms(bookId)).wait();
      seedTransactions.push({ type, bookId, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
    }
  }
  const block = await provider.getBlock('latest');
  const library = { schemaVersion: 1, status: 'deployed', chainId: 20261, abiVersion: 1, environment: 'local-anvil',
    verifiedAt: { blockNumber: block.number, blockHash: block.hash }, escrow: { ...contracts.LibraryDepositEscrow, abi: fixture.abi },
    roles: { deployer: accounts[0], administrator: accounts[0], librarian: accounts[1] }, treasury: accounts[2], policy: fixture.policy, books, seedTransactions };
  const manifest = { schemaVersion: 1, status: 'deployed', chainId: 20261, abiVersion: 1, environment: 'local-anvil',
    contracts: Object.fromEntries(Object.entries(contracts).filter(([n]) => n !== 'LibraryDepositEscrow')),
    roles: { deployer: accounts[0], sbtIssuer: accounts[0], grantIssuer: accounts[0], posSigner: accounts[1] },
    merchants: { parking: { address: accounts[4], category: id('PARKING') }, canteen: { address: accounts[5], category: id('FOOD') } }, library };
  writeFileSync(join(workspace, 'deployments/intracampus.json'), JSON.stringify(manifest));
  const { LibraryRepository } = await importFrom('backend/src/modules/library/library.repository.ts');
  const { LibraryService } = await importFrom('backend/src/modules/library/library.service.ts');
  const { AuthService } = await importFrom('backend/src/modules/auth/auth.service.ts');
  const { AuthRepository } = await importFrom('backend/src/modules/auth/auth.repository.ts');
  repository = new LibraryRepository(join(evidenceDir, `pilot-${Date.now()}.sqlite`));
  repository.seedDemo({ version: 1, books: books.map((b, i) => ({ ...b, title: titles[i], author: 'Tác giả demo', isbn: null,
    copies: [{ copyId: `copy-${i}`, barcode: `demo-${i}` }] })), accounts: [{ wallet: accounts[3], role: 'STUDENT' }, { wallet: accounts[6], role: 'STUDENT' }, { wallet: accounts[1], role: 'LIBRARIAN' }] });
  let clockOffset = block.timestamp - Math.floor(Date.now() / 1000); const now = () => Math.floor(Date.now() / 1000) + clockOffset;
  const authConfig = { origin, domain: new URL(origin).host, chainId: 20261, challengeTtlSeconds: 300, sessionTtlSeconds: 864000,
    challengeRateLimit: { maxRequests: 30, windowSeconds: 60 }, verifyRateLimit: { maxRequests: 30, windowSeconds: 60 },
    trustedProxyAddresses: ['127.0.0.1','::1'], cookieName: 'library_session', secureCookie: false };
  service = new LibraryService(repository, { deployment: manifest, allowLocal: true, rpcUrl,
    chainFreshness: { maxStaleSeconds: 300, maxFutureDriftSeconds: 30, minConfirmations: 1 }, now });
  const auth = new AuthService(new AuthRepository(repository), authConfig, now);
  apiServer = createServer(createApp(rpcUrl, undefined, undefined, undefined, auth, authConfig, service)).listen(0, '127.0.0.1'); await once(apiServer, 'listening');
  next = spawn(process.execPath, ['server.mjs','--dev','--hostname','127.0.0.1','--port','3129'], { cwd: join(workspace,'frontend'), windowsHide: true,
    env: { ...process.env, BACKEND_URL: `http://127.0.0.1:${apiServer.address().port}`, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_ALLOW_LOCAL_ANVIL: 'true', NEXT_PUBLIC_INTRACAMPUS_RPC_URL: rpcUrl }, stdio: ['ignore','pipe','pipe'] });
  let nextOutput = ''; next.stdout.on('data', b => { nextOutput += b; }); next.stderr.on('data', b => { nextOutput += b; });
  for (let i = 0; ; i++) {
    try { const r = await fetch(origin + '/student/library'); if (r.status === 200) break; } catch {}
    if (i > 120 || next.exitCode !== null) throw new Error(`Next failed: ${nextOutput}`); await delay(500);
  }
  const { chromium } = await import(pathToFileURL(join(playwrightDir, 'index.mjs')).href);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let beforeStudentBroadcast;
  await context.exposeBinding('pilotRpc', async (_source, { method, params }) => {
    if (method === 'personal_sign') return provider.send('eth_sign', [params[1], params[0]]);
    let waitForReceipt = false;
    if (method === 'eth_sendTransaction' && beforeStudentBroadcast) {
      const run = beforeStudentBroadcast;
      beforeStudentBroadcast = undefined;
      params = await run(params);
      waitForReceipt = true;
    }
    const result = await provider.send(method, params);
    if (waitForReceipt) await provider.waitForTransaction(result, 1, 30000);
    if (method === 'eth_sendTransaction') sends.push(result);
    return result;
  });
  await context.addInitScript(({ account, second }) => {
    let selected = account, chain = '0x4f25'; const listeners = new Map();
    window.pilotWallet = { unknown: false, switchAccount() { selected = second; for (const f of listeners.get('accountsChanged') ?? []) f([selected]); } };
    window.ethereum = { on(name, f) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(f); }, removeListener(name, f) { listeners.get(name)?.delete(f); },
      async request({ method, params = [] }) {
        if (['eth_accounts','eth_requestAccounts'].includes(method)) return [selected];
        if (method === 'eth_chainId') return chain;
        const result = await window.pilotRpc({ method, params });
        if (method === 'eth_sendTransaction' && window.pilotWallet.unknown) { window.pilotWallet.unknown = false; throw new Error('transport interrupted after send'); }
        return result;
      } };
  }, { account: accounts[3], second: accounts[6] });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/student/library');
  await page.getByRole('button', { name: 'Ký đăng nhập thư viện' }).click();
  await page.getByRole('heading', { name: titles[0], exact: true }).waitFor(); record('wallet challenge → Next cookie → real Express/SQLite catalog');
  await page.getByLabel('Tên sách, tác giả hoặc ISBN').fill('no-such-book'); await page.getByRole('button', { name: 'Tìm sách', exact: true }).click();
  await page.getByText('Chưa có sách phù hợp.', { exact: false }).waitFor(); record('search empty state');
  await page.getByLabel('Tên sách, tác giả hoặc ISBN').fill(''); await page.getByRole('button', { name: 'Tìm sách', exact: true }).click();
  const student = { wallet: accounts[3], role: 'STUDENT' }, staff = { wallet: accounts[1], role: 'LIBRARIAN' };
  async function refresh() { await page.getByRole('button', { name: 'Làm mới trạng thái', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Đang xử lý' }).waitFor({ state: 'hidden' }); }
  async function sendReview() {
    const before = sends.length;
    await page.getByRole('button', { name: 'Xác nhận và mở ví', exact: true }).click();
    for (let attempt = 0; sends.length === before && attempt < 100; attempt++) await delay(100);
    assert.equal(sends.length, before + 1);
    await provider.waitForTransaction(sends.at(-1), 1, 30000); await refresh();
  }
  async function deposit(index, unknown = false) {
    await page.getByRole('button', { name: `Tạo yêu cầu: ${titles[index]}`, exact: true }).click();
    await page.getByRole('heading', { name: 'Nộp cọc · kiểm tra trước khi ký' }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-labelledby') === 'review-title');
    if (unknown) await page.evaluate(() => { window.pilotWallet.unknown = true; });
    await sendReview();
    await page.getByText('Đã cọc · chờ thủ thư duyệt', { exact: true }).waitFor();
    const request = (await service.listRequests(student)).find(r => r.bookId === books[index].bookId); assert.ok(request); return request;
  }
  const request = await deposit(0, true); assert.equal((await service.listLoans(student)).length, 0); record('real deposit is pending approval, never ACTIVE');
  await page.reload(); await page.getByText('Đã cọc · chờ thủ thư duyệt', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Đối chiếu nộp cọc', exact: true }).click(); await page.getByText('Nộp cọc', { exact: true }).waitFor();
  assert.equal(sends.length, 1); record('unknown send + reload reconciles by request with one broadcast');
  const staffEscrow = escrow.connect(signers[1]);
  await (await staffEscrow.approve(request.requestId)).wait(); await refresh();
  await page.getByText('Đang mượn', { exact: true }).waitFor(); record('staff chain approval projects to Student ACTIVE');
  await page.getByRole('button', { name: 'Yêu cầu trả sách', exact: true }).click(); await page.getByText('Đưa sách cho thủ thư kiểm tra.', { exact: false }).first().waitFor();
  await (await staffEscrow.confirmPhysicalReturn(request.requestId)).wait(); await service.getRequest(student, request.requestId);
  const returnIntent = await service.createSettlementIntent(staff, request.requestId, { outcome: 'RETURNED', condition: 'GOOD', reason: 'Local pilot physical return', repairRequestedWei: '0' });
  const returned = await signers[1].sendTransaction({ to: returnIntent.walletCall.to, data: returnIntent.walletCall.data, value: BigInt(returnIntent.walletCall.valueWei) }); await returned.wait();
  await service.submitTransaction(staff, request.requestId, { action: 'return', txHash: returned.hash, settlementIntentId: returnIntent.intentId });
  await refresh(); await page.getByText('Đã trả và quyết toán', { exact: true }).first().waitFor(); record('return request → physical receipt → verified settlement/refund');
  const lost = await deposit(1); await (await staffEscrow.approve(lost.requestId)).wait(); await service.getRequest(student, lost.requestId);
  const lostIntent = await service.createSettlementIntent(staff, lost.requestId, { outcome: 'LOST', reason: 'Local pilot lost book' });
  const lostTx = await signers[1].sendTransaction({ to: lostIntent.walletCall.to, data: lostIntent.walletCall.data, value: 0 }); await lostTx.wait();
  await service.submitTransaction(staff, lost.requestId, { action: 'settle', txHash: lostTx.hash, settlementIntentId: lostIntent.intentId });
  await refresh(); await page.getByRole('button', { name: 'Xem phần thiếu trước khi ký' }).click();
  await page.getByRole('heading', { name: 'Thanh toán phần thiếu · kiểm tra trước khi ký' }).waitFor();
  await sendReview(); await page.getByText('Đã tất toán sách mất', { exact: true }).first().waitFor(); record('lost book exact 30 CAMPUS shortfall paid by Student wallet');
  const expired = await deposit(2); await provider.send('evm_increaseTime', [86401]); await provider.send('evm_mine', []); clockOffset += 86401;
  await refresh(); await page.getByRole('button', { name: 'Xem hoàn cọc hết hạn' }).click(); await sendReview();
  await page.getByText('Đã hoàn cọc', { exact: true }).waitFor(); assert.equal((await service.getRequest(student, expired.requestId)).refundStatus, 'REFUNDED'); record('expired refund returns original borrower funds');
  async function prepareNoCopyRefund(index) {
    const second = { wallet: accounts[6], role: 'STUDENT' };
    const bookId = books[index].bookId;
    const [reserved, noCopy] = await Promise.all([
      service.createRequest({ account: second, bookId, idempotencyKey: `pilot-last-copy-first-${index}` }),
      service.createRequest({ account: student, bookId, idempotencyKey: `pilot-last-copy-second-${index}` }),
    ]);
    assert.equal((await service.listBooks(student.wallet)).find(book => book.bookId === bookId).copiesAvailable, 1);
    await (await escrow.connect(signers[6]).deposit(reserved.request.requestId, bookId, { value: fixture.policy.depositWei })).wait();
    await (await escrow.connect(signers[3]).deposit(noCopy.request.requestId, bookId, { value: fixture.policy.depositWei })).wait();
    await refresh();
    const { requestId } = noCopy.request;
    const missed = await service.getRequest(student, requestId);
    assert.equal(missed.status, 'REJECTED_NO_COPY');
    assert.equal(missed.loanId, null);
    const card = page.locator('li.library-record').filter({ hasText: requestId });
    const claim = card.getByRole('button', { name: 'Xem hoàn cọc hết hạn' });
    assert.equal(await claim.count(), 0);
    await provider.send('evm_increaseTime', [86401]); await provider.send('evm_mine', []); clockOffset += 86401;
    await refresh();
    return { requestId, card, claim };
  }
  const { requestId: missedId, card: noCopyCard, claim } = await prepareNoCopyRefund(2);
  await claim.click();
  await sendReview();
  await noCopyCard.getByText('Hết bản · đã hoàn cọc', { exact: true }).waitFor();
  assert.equal(await claim.count(), 0);
  const refunded = await service.getRequest(student, missedId);
  assert.equal(refunded.refundStatus, 'REFUNDED');
  assert.equal(refunded.transactions.find(tx => tx.action === 'refund')?.proof?.eventName, 'ExpiredRefundClaimed');
  record('last-copy contention preserves one allocation and lets the other borrower claim after deadline');
  const race = await prepareNoCopyRefund(0);
  await race.claim.click();
  await page.getByRole('heading', { name: 'Nhận lại cọc hết hạn · kiểm tra trước khi ký' }).waitFor();
  let librarianRefundHash;
  beforeStudentBroadcast = async ([tx]) => {
    assert.equal(tx.data, escrow.interface.encodeFunctionData('claimExpiredRefund', [race.requestId]));
    const balance = await provider.getBalance(student.wallet);
    const librarianRefund = await (await staffEscrow.reject(race.requestId)).wait();
    assert.equal(librarianRefund.status, 1);
    assert.equal((await provider.getBalance(student.wallet)) - balance, BigInt(fixture.policy.depositWei));
    librarianRefundHash = librarianRefund.hash;
    // The approved demo transaction lands after the librarian's refund.
    return [{ ...tx, gas: '0x30d40' }];
  };
  const sendsBeforeRace = sends.length;
  await sendReview();
  const borrowerClaimHash = sends.at(-1);
  const claimHistory = race.card.locator('.library-recovery').filter({ hasText: 'Nhận lại cọc hết hạn' });
  await race.card.getByText('Đã hoàn cọc', { exact: true }).waitFor();
  await claimHistory.getByText('Giao dịch thất bại', { exact: false }).waitFor();
  await claimHistory.getByText(borrowerClaimHash, { exact: true }).waitFor();
  await race.card.getByText(librarianRefundHash, { exact: true }).waitFor();
  await page.reload();
  await race.card.getByText('Đã hoàn cọc', { exact: true }).waitFor();
  await claimHistory.getByText('Giao dịch thất bại', { exact: false }).waitFor();
  await claimHistory.getByRole('button', { name: 'Đối chiếu nhận lại cọc hết hạn' }).click();
  await page.getByText('Đã đối chiếu. Nếu vẫn chưa rõ kết quả', { exact: false }).waitFor();
  await claimHistory.getByText('Giao dịch thất bại', { exact: false }).waitFor();
  assert.equal(sends.length, sendsBeforeRace + 1);
  await assert.rejects(service.submitTransaction(student, race.requestId, { action: 'refund', txHash: id('unrelated-refund') }), /CONFLICT/);
  const settledRace = await service.getRequest(student, race.requestId);
  assert.equal(settledRace.refundStatus, 'REFUNDED');
  assert.equal(settledRace.transactions.find(tx => tx.action === 'refund')?.status, 'REVERTED');
  const refundRace = { requestId: race.requestId, librarianRefundHash, borrowerClaimHash };
  await race.card.screenshot({ path: join(evidenceDir, 'student-refund-race.png') });
  record('librarian refund and borrower revert stay distinct after reload and repeat tracking without a resend');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); record('390px no horizontal overflow');
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body)); record('keyboard focus and inline confirmation focus');
  await page.evaluate(() => document.activeElement?.blur());
  await page.screenshot({ path: join(evidenceDir, 'student-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: join(evidenceDir, 'student-desktop.png'), fullPage: true });
  const challenge = await (await context.request.post(origin + '/api/auth/challenge', { headers: { Origin: origin }, data: { wallet: accounts[6] } })).json();
  const signature = await provider.send('eth_sign', [accounts[6], '0x' + Buffer.from(challenge.message, 'utf8').toString('hex')]);
  assert.equal((await context.request.post(origin + '/api/auth/verify', { headers: { Origin: origin }, data: { challengeId: challenge.challengeId, signature } })).status(), 200);
  await refresh(); await page.getByRole('button', { name: 'Ký đăng nhập thư viện' }).waitFor();
  assert.equal(await page.getByText('Đã trả và quyết toán', { exact: true }).count(), 0);
  record('another-tab session mismatch clears private state and exposes sign-in');
  await page.getByRole('button', { name: 'Ký đăng nhập thư viện' }).click(); await page.getByRole('button', { name: 'Làm mới trạng thái' }).waitFor();
  await page.evaluate(() => window.pilotWallet.switchAccount()); await page.getByRole('button', { name: 'Ký đăng nhập thư viện' }).waitFor();
  assert.equal(await page.getByText('Đã trả và quyết toán', { exact: true }).count(), 0); record('account switch clears prior private history and requires new login');
  assert.deepEqual(errors, []);
  const receipts = await Promise.all([...sends, librarianRefundHash].map(async txHash => {
    const receipt = await provider.getTransactionReceipt(txHash);
    assert.equal(receipt?.status, txHash === borrowerClaimHash ? 0 : 1);
    const events = receipt.logs.filter(log => log.address.toLowerCase() === library.escrow.address.toLowerCase()).map(log => {
      const event = escrow.interface.parseLog(log);
      return { name: event.name, requestId: event.args.requestId, contractAddress: log.address, logIndex: log.index };
    });
    return { txHash, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, events };
  }));
  assert.equal(receipts.find(receipt => receipt.txHash === librarianRefundHash)?.events[0]?.name, 'RequestRejected');
  const sourceFiles = ['frontend/app/student/library/LibrarySession.tsx', 'frontend/app/student/library/LibraryRequests.tsx',
    'frontend/lib/library-transactions.ts', 'frontend/lib/library-api.ts', 'frontend/test/library-student-pilot.mjs',
    'backend/src/modules/library/library.service.ts'];
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(join(workspace, file))).digest('hex')]));
  writeFileSync(join(evidenceDir, 'evidence.json'), JSON.stringify({ environment: 'local-anvil', chainId: 20261, cases, sends, receipts, errors,
    refundRace, sourceHashes, manualCore: 'NOT_RUN', avalancheL1: 'NOT_RUN' }, null, 2) + '\n');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ path: join(evidenceDir, 'failure.png'), fullPage: true }); console.error(await page.locator('body').innerText()); }
  throw error;
} finally {
  await browser?.close();
  if (next?.pid) spawnSync('taskkill', ['/PID', String(next.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  if (apiServer) { apiServer.closeAllConnections(); await new Promise(done => apiServer.close(done)); }
  service?.close(); repository?.close(); provider.destroy();
}
