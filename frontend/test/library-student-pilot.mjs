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
  const seedTransactions = [], prices = ['30000000000000000000','80000000000000000000','50000000000000000000','40000000000000000000','30000000000000000000','50000000000000000000'];
  const titles = ['Lập trình căn bản','Cấu trúc dữ liệu','Mạng máy tính','Hệ điều hành','Cơ sở dữ liệu','Kỹ thuật phần mềm'];
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
  await context.exposeBinding('pilotRpc', async (_source, { method, params }) => {
    if (method === 'personal_sign') return provider.send('eth_sign', [params[1], params[0]]);
    const result = await provider.send(method, params);
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
  const student = { wallet: accounts[3], role: 'STUDENT' };
  // Separate browser contexts preserve separate Student and LIBRARIAN cookies.
  // Both wallets use unlocked accounts on the dedicated Anvil, never a real key.
  const staffContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await staffContext.exposeBinding('pilotRpc', async (_source, { method, params }) => {
    if (method === 'personal_sign') return provider.send('eth_sign', [params[1], params[0]]);
    const result = await provider.send(method, params);
    if (method === 'eth_sendTransaction') sends.push(result);
    return result;
  });
  await staffContext.addInitScript(({ account, studentAccount }) => {
    let selected = account; const listeners = new Map();
    window.pilotWallet = { unknown: false, switchAccount() { selected = studentAccount; for (const f of listeners.get('accountsChanged') ?? []) f([selected]); } };
    window.ethereum = { on(name, f) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(f); }, removeListener(name, f) { listeners.get(name)?.delete(f); },
      async request({ method, params = [] }) {
        if (['eth_accounts','eth_requestAccounts'].includes(method)) return [selected];
        if (method === 'eth_chainId') return '0x4f25';
        const result = await window.pilotRpc({ method, params });
        if (method === 'eth_sendTransaction' && window.pilotWallet.unknown) { window.pilotWallet.unknown = false; throw new Error('transport interrupted after send'); }
        return result;
      } };
  }, { account: accounts[1], studentAccount: accounts[3] });
  const staffPage = await staffContext.newPage(); staffPage.on('pageerror', e => errors.push(e.message));
  await staffPage.goto(origin + '/staff/library');
  await staffPage.getByRole('button', { name: 'Ký đăng nhập thủ thư' }).click();
  await staffPage.getByRole('button', { name: 'Làm mới trạng thái' }).waitFor();
  async function refresh() { await page.getByRole('button', { name: 'Làm mới trạng thái', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Đang xử lý' }).waitFor({ state: 'hidden' }); }
  async function refreshStaff() {
    await staffPage.getByRole('button', { name: 'Làm mới trạng thái', exact: true }).click();
    await staffPage.getByRole('status').filter({ hasText: 'Đang xử lý' }).waitFor({ state: 'hidden' });
  }
  async function staffSend(eventName, failTrack = false) {
    const before = sends.length;
    const trackPattern = '**/api/library/requests/*/transactions';
    if (failTrack) await staffPage.route(trackPattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RPC_UNAVAILABLE' } }) }));
    await staffPage.getByRole('button', { name: 'Xác nhận và mở ví', exact: true }).click();
    for (let attempt = 0; sends.length === before && attempt < 100; attempt++) await delay(100);
    assert.equal(sends.length, before + 1, 'staff UI must broadcast exactly once');
    await provider.waitForTransaction(sends.at(-1), 1, 30000);
    const journal = staffPage.getByRole('article').filter({ hasText: sends.at(-1) });
    if (failTrack) {
      await staffPage.locator('#staff-error').waitFor();
      assert.equal(sends.length, before + 1, 'failed reconcile must retain the original send');
      await staffPage.unroute(trackPattern);
      record('staff reconcile failure retains hash and allows safe retry');
    }
    await journal.getByRole('button', { name: 'Đối chiếu', exact: true }).click();
    await journal.getByText(`Đã xác minh ${eventName}`, { exact: false }).waitFor();
    await refreshStaff();
  }
  async function approve(requestId, failTrack = false) {
    await refreshStaff();
    await staffPage.getByRole('article', { name: `Yêu cầu ${requestId}` }).getByRole('button', { name: 'Duyệt', exact: true }).click();
    await staffSend('LoanApproved', failTrack);
  }
  function formatWei(value) {
    const unit = 10n ** 18n, wei = BigInt(value), fraction = (wei % unit).toString().padStart(18, '0').replace(/0+$/, '');
    const whole = (wei / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${whole}${fraction ? `,${fraction}` : ''} CAMPUS`;
  }
  async function assertBreakdown(card, label, value) {
    const row = card.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('..');
    assert.equal(await row.locator('dd').innerText(), value, `${label} must match the API/fixture oracle`);
  }
  async function returnBook(requestId) {
    await refreshStaff();
    const loan = staffPage.getByRole('article', { name: `Khoản mượn ${requestId}` });
    await loan.getByRole('button', { name: 'Xác nhận nhận sách', exact: true }).click();
    await staffSend('PhysicalReturnConfirmed');
    await loan.getByRole('button', { name: 'Quyết toán trả', exact: true }).click();
    await staffPage.getByLabel('Lý do').fill('Local pilot physical return');
    await staffPage.getByLabel('Tình trạng sách').selectOption('DAMAGED');
    const amount = staffPage.getByLabel('Phí sửa chữa (CAMPUS)');
    const count = sends.length;
    for (const invalid of ['0', '-1', '1e2', '0.0000000000000000001', ((2n ** 256n) / (10n ** 18n) + 1n).toString()]) {
      await amount.fill(invalid);
      await staffPage.getByRole('button', { name: 'Xem quyết toán', exact: true }).click();
      await staffPage.locator('#staff-error').waitFor();
      assert.equal(sends.length, count, `invalid repair amount ${invalid} must not broadcast`);
    }
    await amount.fill('0.000000000000000001');
    const intentPattern = '**/api/library/loans/*/settlement-intents';
    await staffPage.route(intentPattern, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RPC_UNAVAILABLE' } }) }));
    await staffPage.getByRole('button', { name: 'Xem quyết toán', exact: true }).click();
    await staffPage.locator('#staff-error').waitFor();
    assert.equal(sends.length, count, 'failed preview must not broadcast');
    await staffPage.unroute(intentPattern);
    record('repair input rejects invalid precision and range; preview API failure does not send');
    let releaseIntent, receivedIntent, deliveredIntent;
    const heldIntent = new Promise(resolve => { releaseIntent = resolve; });
    const intentReceived = new Promise(resolve => { receivedIntent = resolve; });
    const intentDelivered = new Promise(resolve => { deliveredIntent = resolve; });
    let intentRequestCount = 0, retryIntent;
    await staffPage.route(intentPattern, async route => {
      intentRequestCount++;
      if (intentRequestCount > 1) { const response = await route.fetch(); retryIntent = await response.json(); await route.fulfill({ response }); return; }
      receivedIntent(); await heldIntent; const response = await route.fetch(); await route.fulfill({ response }); deliveredIntent();
    });
    await staffPage.getByRole('button', { name: 'Xem quyết toán', exact: true }).click();
    await intentReceived;
    await staffPage.getByRole('region', { name: 'Thông tin quyết toán' }).getByRole('button', { name: 'Hủy', exact: true }).click();
    // Retry the same loan while the first response is still held: cancel must
    // release the per-action Web Lock, not merely clear the visual busy state.
    await loan.getByRole('button', { name: 'Quyết toán trả', exact: true }).click();
    await staffPage.getByLabel('Lý do').fill('Retry cancelled preview');
    await staffPage.getByLabel('Tình trạng sách').selectOption('DAMAGED');
    const damagedRepair = fixture.returnVectors.find(vector => vector.name === 'thirty days late plus repair').repairRequestedWei;
    await staffPage.getByLabel('Phí sửa chữa (CAMPUS)').fill((BigInt(damagedRepair) / 10n ** 18n).toString());
    await staffPage.getByRole('button', { name: 'Xem quyết toán', exact: true }).click();
    const retriedReview = staffPage.getByRole('region', { name: 'Kiểm tra trước khi ký' });
    await retriedReview.waitFor({ timeout: 5000 });
    assert.equal(intentRequestCount, 2, 'same-loan retry must reach API while old response is held');
    assert.equal(retryIntent.preview.repairFeeWei, damagedRepair);
    assert.equal(retryIntent.preview.lateFeeWei, fixture.returnVectors.find(vector => vector.name === 'on time').expectedLateFeeWei);
    assert.equal(BigInt(retryIntent.preview.refundWei), BigInt(fixture.policy.depositWei) - BigInt(damagedRepair));
    for (const [label, value] of [['Phí trễ', retryIntent.preview.lateFeeWei], ['Phí sửa chữa', retryIntent.preview.repairFeeWei], ['Tổng giữ lại', retryIntent.preview.totalRetainedWei], ['Hoàn cho người mượn', retryIntent.preview.refundWei]]) await assertBreakdown(retriedReview, label, formatWei(value));
    record('DAMAGED preview matches server and fixture with nonzero repair');
    await retriedReview.getByRole('button', { name: 'Hủy', exact: true }).click();
    let releaseRefresh, receivedRefresh;
    const heldRefresh = new Promise(resolve => { releaseRefresh = resolve; });
    const refreshReceived = new Promise(resolve => { receivedRefresh = resolve; });
    const booksPattern = /\/api\/library\/books(?:\?|$)/;
    await staffPage.route(booksPattern, async route => { receivedRefresh(); await heldRefresh; await route.continue(); });
    const refreshButton = staffPage.getByRole('button', { name: 'Làm mới trạng thái', exact: true });
    await refreshButton.click({ timeout: 5000 });
    await refreshReceived;
    assert.equal(await refreshButton.isDisabled(), true, 'new refresh must be busy while its response is held');
    releaseIntent();
    await intentDelivered;
    await delay(300);
    assert.equal(await refreshButton.isDisabled(), true, 'old preview response must not clear newer refresh busy state');
    releaseRefresh();
    await staffPage.getByRole('status').filter({ hasText: 'Đang xử lý' }).waitFor({ state: 'hidden' });
    await staffPage.unroute(intentPattern);
    await staffPage.unroute(booksPattern);
    assert.equal(await staffPage.getByRole('region', { name: 'Thông tin quyết toán' }).count(), 0);
    assert.equal(await staffPage.getByRole('region', { name: 'Kiểm tra trước khi ký' }).count(), 0);
    assert.equal(sends.length, count, 'cancelled delayed preview must not broadcast');
    record('cancel delayed preview releases same-loan lock and old response preserves newer operation busy state');
    await loan.getByRole('button', { name: 'Quyết toán trả', exact: true }).click();
    await staffPage.getByLabel('Lý do').fill('Local pilot physical return');
    await staffPage.getByRole('button', { name: 'Xem quyết toán', exact: true }).click();
    await staffSend('ReturnSettled');
  }
  async function markLost(requestId, vectorName, commit = true) {
    await refreshStaff();
    const loan = staffPage.getByRole('article', { name: `Khoản mượn ${requestId}` });
    await loan.getByRole('button', { name: 'Báo mất', exact: true }).click();
    const form = staffPage.getByRole('region', { name: 'Thông tin quyết toán' }).locator('form');
    assert.equal(await form.evaluate(element => element.checkValidity()), false, 'lost form must require confirmation and reason');
    await staffPage.getByLabel('Tôi xác nhận chưa nhận lại sách vật lý').check();
    await staffPage.getByLabel('Lý do').fill('Local pilot lost book');
    const pattern = '**/api/library/loans/*/settlement-intents'; let apiIntent;
    await staffPage.route(pattern, async route => { const response = await route.fetch(); apiIntent = await response.json(); await route.fulfill({ response }); });
    await staffPage.getByRole('button', { name: 'Xem quyết toán', exact: true }).click();
    const preview = staffPage.getByRole('region', { name: 'Kiểm tra trước khi ký' }); await preview.waitFor();
    await staffPage.unroute(pattern);
    const vector = fixture.lostVectors.find(item => item.name === vectorName); assert.ok(vector);
    for (const [key, expected, label] of [['replacementPriceWei', vector.replacementPriceWei, 'Giá thay thế'], ['totalRetainedWei', vector.expectedRetainedWei, 'Tổng giữ lại'], ['refundWei', vector.expectedRefundWei, 'Hoàn cho người mượn'], ['shortfallWei', vector.expectedShortfallWei, 'Sinh viên cần trả thêm']]) {
      assert.equal(apiIntent.preview[key], expected, `${vectorName} ${key}`); await assertBreakdown(preview, label, formatWei(expected));
    }
    record(`lost preview matches fixture: ${vectorName}`);
    if (commit) await staffSend('LostSettled');
    else await preview.getByRole('button', { name: 'Hủy', exact: true }).click();
  }
  async function sendReview() {
    const before = sends.length;
    await page.getByRole('button', { name: 'Xác nhận và mở ví', exact: true }).click();
    for (let attempt = 0; sends.length === before && attempt < 100; attempt++) await delay(100);
    assert.equal(sends.length, before + 1);
    await provider.waitForTransaction(sends.at(-1), 1, 30000); await refresh();
  }
  async function deposit(index, unknown = false) {
    await page.bringToFront();
    await refresh();
    await page.getByRole('button', { name: `Tạo yêu cầu: ${titles[index]}`, exact: true }).click();
    await page.getByRole('heading', { name: 'Nộp cọc · kiểm tra trước khi ký' }).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-labelledby') === 'review-title');
    if (unknown) await page.evaluate(() => { window.pilotWallet.unknown = true; });
    await sendReview();
    await page.getByText('Đã cọc · chờ thủ thư duyệt', { exact: true }).first().waitFor();
    const request = (await service.listRequests(student)).find(r => r.bookId === books[index].bookId); assert.ok(request); return request;
  }
  const request = await deposit(0, true); assert.equal((await service.listLoans(student)).length, 0); record('real deposit is pending approval, never ACTIVE');
  await page.reload(); await page.getByText('Đã cọc · chờ thủ thư duyệt', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Đối chiếu nộp cọc', exact: true }).click(); await page.getByText('Nộp cọc', { exact: true }).waitFor();
  assert.equal(sends.length, 1); record('unknown send + reload reconciles by request with one broadcast');
  await approve(request.requestId, true); await refresh();
  await page.getByText('Đang mượn', { exact: true }).waitFor(); record('staff chain approval projects to Student ACTIVE');
  await page.getByRole('button', { name: 'Yêu cầu trả sách', exact: true }).click(); await page.getByText('Đưa sách cho thủ thư kiểm tra.', { exact: false }).first().waitFor();
  await returnBook(request.requestId);
  await refresh(); await page.getByText('Đã trả và quyết toán', { exact: true }).first().waitFor(); record('return request → physical receipt → verified settlement/refund');
  const lost = await deposit(1); await approve(lost.requestId); await markLost(lost.requestId, 'replacement above deposit');
  await staffPage.reload();
  const returnedLoan = staffPage.getByRole('article', { name: `Khoản mượn ${request.requestId}` });
  const lostLoan = staffPage.getByRole('article', { name: `Khoản mượn ${lost.requestId}` });
  await returnedLoan.getByText('Kết quả: Sách trả', { exact: false }).waitFor();
  await lostLoan.getByText('Kết quả: Sách mất', { exact: false }).waitFor();
  for (const label of ['Phí trễ', 'Phí sửa chữa', 'Cọc giữ do quá hạn', 'Tổng giữ lại']) await assertBreakdown(returnedLoan, label, '0 CAMPUS');
  await assertBreakdown(returnedLoan, 'Hoàn cho người mượn', '50 CAMPUS');
  await assertBreakdown(lostLoan, 'Giá thay thế', '80 CAMPUS');
  await assertBreakdown(lostLoan, 'Tổng giữ lại', '50 CAMPUS');
  await assertBreakdown(lostLoan, 'Hoàn cho người mượn', '0 CAMPUS');
  await assertBreakdown(lostLoan, 'Sinh viên cần trả thêm', '30 CAMPUS');
  record('settlement breakdown persists after reload including zero values');
  await refresh(); await page.getByRole('button', { name: 'Xem phần thiếu trước khi ký' }).click();
  await page.getByRole('heading', { name: 'Thanh toán phần thiếu · kiểm tra trước khi ký' }).waitFor();
  await sendReview(); await page.getByText('Đã tất toán sách mất', { exact: true }).first().waitFor(); record('lost book exact 30 CAMPUS shortfall paid by Student wallet');
  for (const [index, vectorName] of [[4, 'replacement below deposit'], [5, 'replacement equals deposit']]) {
    const loan = await deposit(index); await approve(loan.requestId); await markLost(loan.requestId, vectorName, false);
  }
  const expired = await deposit(2); await provider.send('evm_increaseTime', [86401]); await provider.send('evm_mine', []); clockOffset += 86401;
  await refresh(); await page.getByRole('button', { name: 'Xem hoàn cọc hết hạn' }).click(); await sendReview();
  await page.getByText('Đã hoàn cọc', { exact: true }).waitFor(); assert.equal((await service.getRequest(student, expired.requestId)).refundStatus, 'REFUNDED'); record('expired refund returns original borrower funds');
  const rejected = await deposit(3); await refreshStaff();
  await staffPage.getByRole('article', { name: `Yêu cầu ${rejected.requestId}` }).getByRole('button', { name: 'Từ chối', exact: true }).click();
  await staffPage.evaluate(() => { window.pilotWallet.unknown = true; });
  const beforeReject = sends.length;
  await staffPage.getByRole('button', { name: 'Xác nhận và mở ví', exact: true }).click();
  for (let attempt = 0; sends.length === beforeReject && attempt < 100; attempt++) await delay(100);
  assert.equal(sends.length, beforeReject + 1);
  await provider.waitForTransaction(sends.at(-1), 1, 30000);
  await service.getRequest(student, rejected.requestId);
  const damagedJournalId = id('pilot-damaged-journal');
  await staffPage.evaluate(requestId => {
    const key = Object.keys(localStorage).find(name => name.startsWith('intracampus.library.v1:') && name.endsWith(':reject'));
    if (!key) throw new Error('Missing reject journal in fixture');
    localStorage.setItem(key.replace(/:[^:]+:reject$/, ':' + requestId + ':confirmReturn'), '{');
  }, damagedJournalId);
  await staffPage.reload();
  const recoveryRegion = staffPage.getByRole('region', { name: 'Đối chiếu giao dịch' });
  await recoveryRegion.getByRole('alert').filter({ hasText: damagedJournalId }).getByText('Không đọc được nhật ký này.', { exact: false }).waitFor();
  const recovery = recoveryRegion.getByRole('article').filter({ hasText: rejected.requestId });
  await recovery.getByRole('button', { name: 'Đối chiếu', exact: true }).click();
  await recovery.getByText('Đã xác minh RequestRejected', { exact: false }).waitFor();
  assert.equal(sends.length, beforeReject + 1, 'unknown reject recovery must not rebroadcast');
  assert.equal(await staffPage.getByRole('article', { name: `Yêu cầu ${rejected.requestId}` }).count(), 0);
  record('unknown reject remains recoverable after queue removal and reload');
  record('a corrupt staff journal does not hide healthy entries or the dashboard');
  const second = { wallet: accounts[6], role: 'STUDENT' };
  const bookId = books[2].bookId;
  const [reserved, noCopy] = await Promise.all([
    service.createRequest({ account: second, bookId, idempotencyKey: 'pilot-last-copy-first' }),
    service.createRequest({ account: student, bookId, idempotencyKey: 'pilot-last-copy-second' }),
  ]);
  assert.equal((await service.listBooks(student.wallet)).find(book => book.bookId === bookId).copiesAvailable, 1);
  await (await escrow.connect(signers[6]).deposit(reserved.request.requestId, bookId, { value: fixture.policy.depositWei })).wait();
  await (await escrow.connect(signers[3]).deposit(noCopy.request.requestId, bookId, { value: fixture.policy.depositWei })).wait();
  await refresh();
  const missed = await service.getRequest(student, noCopy.request.requestId);
  assert.equal(missed.status, 'REJECTED_NO_COPY');
  assert.equal(missed.loanId, null);
  const noCopyCard = page.locator('li.library-record').filter({ hasText: missed.requestId });
  const claim = noCopyCard.getByRole('button', { name: 'Xem hoàn cọc hết hạn' });
  assert.equal(await claim.count(), 0);
  await refreshStaff();
  const staffNoCopy = staffPage.getByRole('article', { name: `Yêu cầu ${missed.requestId}` });
  await staffNoCopy.getByRole('button', { name: 'Từ chối' }).waitFor();
  await provider.send('evm_increaseTime', [86401]); await provider.send('evm_mine', []); clockOffset += 86401;
  await refresh();
  await claim.click();
  await sendReview();
  await noCopyCard.getByText('Hết bản · đã hoàn cọc', { exact: true }).waitFor();
  assert.equal(await claim.count(), 0);
  const refunded = await service.getRequest(student, missed.requestId);
  assert.equal(refunded.refundStatus, 'REFUNDED');
  assert.equal(refunded.transactions.find(tx => tx.action === 'refund')?.proof?.eventName, 'ExpiredRefundClaimed');
  record('last-copy contention preserves one allocation and lets the other borrower claim after deadline');
  await refreshStaff();
  assert.equal(await staffNoCopy.count(), 0);
  record('a no-copy request leaves the staff queue once the borrower refund is verified');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); record('390px no horizontal overflow');
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement && document.activeElement !== document.body)); record('keyboard focus and inline confirmation focus');
  await page.evaluate(() => document.activeElement?.blur());
  await page.screenshot({ path: join(evidenceDir, 'student-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 }); await page.screenshot({ path: join(evidenceDir, 'student-desktop.png'), fullPage: true });
  assert.equal(await staffPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await staffPage.keyboard.press('Tab');
  assert.ok(await staffPage.evaluate(() => document.activeElement && document.activeElement !== document.body));
  await staffPage.screenshot({ path: join(evidenceDir, 'staff-mobile.png'), fullPage: true });
  await staffPage.setViewportSize({ width: 1280, height: 900 });
  assert.equal(await staffPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await staffPage.screenshot({ path: join(evidenceDir, 'staff-desktop.png'), fullPage: true });
  record('staff route renders at mobile and desktop without horizontal overflow');
  await staffPage.evaluate(() => window.pilotWallet.switchAccount());
  await staffPage.getByRole('button', { name: 'Ký đăng nhập thủ thư' }).waitFor();
  assert.equal(await staffPage.getByRole('region', { name: 'Hàng chờ duyệt' }).count(), 0);
  record('staff account switch removes private queue and requires new sign-in');
  await staffPage.getByRole('button', { name: 'Ký đăng nhập thủ thư' }).click();
  await staffPage.locator('#staff-error').waitFor();
  assert.equal(await staffPage.getByRole('region', { name: 'Hàng chờ duyệt' }).count(), 0);
  // The original Student context has its own Student cookie; switching an injected
  // wallet must not be assumed to replace a prior Librarian cookie immediately.
  assert.equal((await context.request.get(origin + '/api/library/requests?queue=true')).status(), 403);
  record('student wallet cannot access librarian queue');
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
  const receipts = await Promise.all(sends.map(async txHash => {
    const receipt = await provider.getTransactionReceipt(txHash);
    assert.equal(receipt?.status, 1);
    const events = receipt.logs.filter(log => log.address.toLowerCase() === library.escrow.address.toLowerCase()).map(log => {
      try { const event = escrow.interface.parseLog(log); return { name: event.name, requestId: event.args.requestId, contractAddress: log.address, logIndex: log.index }; }
      catch { return null; }
    }).filter(Boolean);
    return { txHash, status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, events };
  }));
  for (const event of ['LoanApproved', 'PhysicalReturnConfirmed', 'ReturnSettled', 'LostSettled']) {
    assert.ok(receipts.some(receipt => receipt.events.some(item => item.name === event)), `missing ${event} escrow event`);
  }
  record('staff librarian flows complete on isolated stack with no errors');
  const sourceFiles = ['frontend/app/student/library/LibrarySession.tsx', 'frontend/app/student/library/LibraryRequests.tsx', 'frontend/app/staff/library/LibraryStaffSession.tsx',
    'frontend/lib/library-transactions.ts', 'frontend/lib/library-api.ts', 'frontend/lib/library-session.ts',
    'backend/src/modules/library/library.repository.ts', 'frontend/test/library-student-pilot.mjs'];
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(join(workspace, file))).digest('hex')]));
  writeFileSync(join(evidenceDir, 'evidence.json'), JSON.stringify({ environment: 'local-anvil', chainId: 20261, cases, sends, receipts, errors,
    sourceHashes, manualCore: 'NOT_RUN', avalancheL1: 'NOT_RUN' }, null, 2) + '\n');
} catch (error) {
  for (const [index, context] of (browser?.contexts() ?? []).entries()) {
    const page = context.pages()[0];
    if (page) { await page.screenshot({ path: join(evidenceDir, `failure-${index}.png`), fullPage: true }); console.error(`Browser context ${index}:`, await page.locator('body').innerText()); }
  }
  throw error;
} finally {
  await browser?.close();
  if (next?.pid) spawnSync('taskkill', ['/PID', String(next.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  if (apiServer) { apiServer.closeAllConnections(); await new Promise(done => apiServer.close(done)); }
  service?.close(); repository?.close(); provider.destroy();
}
