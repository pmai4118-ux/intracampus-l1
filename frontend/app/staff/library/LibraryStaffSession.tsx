'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getLibraryDeployment, type LibraryBook, type LibraryLoan, type LibraryRequest, type LibrarySettlement, type LibrarySettlementIntent, type LibrarySettlementIntentRequest } from '@intracampus/network';
import { WalletSession, useCampusWallet } from '../../student/WalletPanel';
import { formatWalletBalance } from '../../../lib/chains';
import { LibraryApi, LibraryUiError, check } from '../../../lib/library-api';
import { LibraryTransactions, type LibraryCall, type StaffAction, type LibraryJournal } from '../../../lib/library-transactions';
import { libraryError } from '../../../lib/library';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const money = (s: string) => formatWalletBalance(BigInt(s));
const date = (s: number | null) => s === null ? '—' : new Date(s * 1000).toLocaleString('vi-VN');
const labels: Record<StaffAction, string> = { approve: 'Duyệt mượn', reject: 'Từ chối mượn', confirmReturn: 'Xác nhận nhận sách', return: 'Quyết toán trả', settle: 'Báo mất' };
const amountLabels: Record<string, string> = { lateFeeWei: 'Phí trễ', repairFeeWei: 'Phí sửa chữa', overdueForfeitWei: 'Cọc giữ do quá hạn', totalRetainedWei: 'Tổng giữ lại', refundWei: 'Hoàn cho người mượn', replacementPriceWei: 'Giá thay thế', shortfallWei: 'Sinh viên cần trả thêm' };
function SettlementDetails({ settlement }: { settlement: LibrarySettlement }) {
  return <><p>Kết quả: {settlement.outcome === 'RETURNED' ? 'Sách trả' : 'Sách mất'}{settlement.outcome === 'RETURNED' && <> · Nhận sách lúc: {date(settlement.returnedAt)} · {settlement.maintenanceRequired ? 'Cần bảo trì' : 'Không cần bảo trì'}</>}</p><dl className="library-details">{Object.entries(settlement).filter(([k]) => k.endsWith('Wei')).map(([k,v]) => <div key={k}><dt>{amountLabels[k] ?? k}</dt><dd>{money(String(v))}</dd></div>)}</dl></>;
}
function waitForPreview<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Preview cancelled', 'AbortError'));
    if (signal.aborted) { void promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function decimalWei(value: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(value)) throw new LibraryUiError('INVALID_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * BigInt(10) ** BigInt(18) + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
  if (n >= BigInt(2) ** BigInt(256)) throw new LibraryUiError('INVALID_AMOUNT');
  return n.toString();
}
async function signIn(api: LibraryApi, wallet: string, signer: (account: string, message: string) => Promise<string>) {
  const challenge = await api.request('/api/auth/challenge', { wallet }) as { challengeId?: unknown; message?: unknown; expiresAt?: unknown };
  check(typeof challenge.challengeId === 'string' && !!challenge.challengeId && typeof challenge.message === 'string' && !!challenge.message && typeof challenge.expiresAt === 'number' && Number.isSafeInteger(challenge.expiresAt));
  const signature = await signer(wallet, challenge.message);
  await api.request('/api/auth/verify', { challengeId: challenge.challengeId, signature });
  await api.session(wallet, 'LIBRARIAN');
}
export default function LibraryStaffSession() { return <WalletSession><Wallet /></WalletSession>; }
function Wallet() {
  const { state, controller } = useCampusWallet();
  return <div className="library-shell"><header className="library-heading"><div><span className="eyebrow">IntraCampus / Thủ thư</span><h1>Quản lý thư viện</h1><p>Duyệt yêu cầu, nhận sách và quyết toán cọc.</p></div><Link href="/student/library" className="secondary-btn">Thư viện sinh viên</Link></header>
    <section className="surface-panel library-wallet" aria-label="Ví và mạng"><div><span className="field-label">Ví đang chọn</span><p><code>{state.address ?? 'Chưa kết nối'}</code></p><span className="network-pill">{state.chainId === BigInt(20261) ? 'IntraCampus · 20261' : 'Cần mạng IntraCampus · 20261'}</span>{state.balanceWei !== null && <p>Số dư: {formatWalletBalance(state.balanceWei)}</p>}</div><div className="library-actions">
      {!state.address && <button type="button" className="primary-cta-btn" onClick={() => void controller.connect()}>Kết nối ví Core</button>}
      {state.address && state.chainId !== BigInt(20261) && <button type="button" className="secondary-btn" onClick={() => void controller.switchNetwork()}>Chuyển mạng IntraCampus</button>}
      {state.address && <button type="button" className="secondary-btn" onClick={() => controller.disconnect()}>Ngắt kết nối</button>}</div>{state.message && <p role="status">{state.message}</p>}</section>
    <Workspace key={`${state.address}:${state.chainId}`} /></div>;
}
function Workspace() {
  const { state: wallet, controller } = useCampusWallet();
  const api = useMemo(() => new LibraryApi(), []);
  const deployment = useMemo(() => { try { return getLibraryDeployment(); } catch { return null; } }, []);
  const [authenticated, setAuthenticated] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [books, setBooks] = useState<LibraryBook[]>([]), [requests, setRequests] = useState<LibraryRequest[]>([]), [loans, setLoans] = useState<LibraryLoan[]>([]), [journals, setJournals] = useState<LibraryJournal[]>([]);
  const [call, setCall] = useState<LibraryCall | null>(null), [intent, setIntent] = useState<LibrarySettlementIntent | null>(null), [selected, setSelected] = useState<{loan: LibraryLoan; outcome: 'RETURNED' | 'LOST'} | null>(null);
  const [reason, setReason] = useState(''), [condition, setCondition] = useState<'GOOD' | 'DAMAGED'>('GOOD'), [repair, setRepair] = useState('0'), [lostConfirmed, setLostConfirmed] = useState(false);
  const active = useRef(true), operation = useRef(false), operationVersion = useRef(0), previewInFlight = useRef(false), previewAbort = useRef<AbortController | null>(null), review = useRef<HTMLElement>(null), settlementForm = useRef<HTMLElement>(null), trigger = useRef<HTMLElement | null>(null), previewVersion = useRef(0);
  const transactions = useMemo(() => {
    if (!deployment || deployment.status !== 'deployed' || !wallet.address) return null;
    return new LibraryTransactions({ deployment, account: wallet.address, role: 'LIBRARIAN', api, wallet: controller, storage: {
      getItem: k => window.localStorage.getItem(k), setItem: (k, v) => window.localStorage.setItem(k, v), removeItem: k => window.localStorage.removeItem(k), key: i => window.localStorage.key(i), get length() { return window.localStorage.length; },
    }, lock: async (key, run) => { if (!navigator.locks) throw new LibraryUiError('LOCK_UNAVAILABLE'); await navigator.locks.request(key, run); } });
  }, [deployment, wallet.address, api, controller]);
  const clear = () => { previewVersion.current++; previewAbort.current?.abort(); setAuthenticated(false); setBooks([]); setRequests([]); setLoans([]); setJournals([]); setCall(null); setIntent(null); setSelected(null); };
  async function refresh() {
    if (!wallet.address || !deployment || deployment.status !== 'deployed' || !same(wallet.address, deployment.roles.librarian)) throw new LibraryUiError('FORBIDDEN');
    await api.session(wallet.address, 'LIBRARIAN');
    setLoading(true); setCall(null); setIntent(null);
    const [b, r, l] = await Promise.all([api.books(), api.requests(true), api.loans()]);
    if (!active.current) return;
    setBooks(b); setRequests(r); setLoans(l); setJournals(transactions?.listJournals() ?? []); setAuthenticated(true); setLoading(false);
  }
  async function run(work: () => Promise<void>, isCurrent: () => boolean = () => true) {
    if (operation.current) return; operation.current = true; const version = ++operationVersion.current; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { const code = (e as {code?: string}).code; const authError = ['UNAUTHENTICATED','WALLET_SESSION_CHANGED','FORBIDDEN'].includes(code ?? ''); if (active.current && version === operationVersion.current && (isCurrent() || authError)) { if (authError) clear(); setError(code === 'INVALID_AMOUNT' ? 'Số tiền sửa chữa không hợp lệ.' : code === 'FORBIDDEN' ? 'Ví này không có quyền thủ thư hoặc session đã hết hạn.' : libraryError(e)); } }
    finally { if (version === operationVersion.current) { operation.current = false; previewInFlight.current = false; previewAbort.current = null; if (active.current) { setBusy(false); setLoading(false); } } }
  }
  useEffect(() => { active.current = true; if (wallet.address) void run(refresh); const focus = () => { if (wallet.address && !operation.current) void run(refresh); }; window.addEventListener('focus', focus); return () => { active.current = false; previewAbort.current?.abort(); window.removeEventListener('focus', focus); }; /* remounted per account */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (call) review.current?.focus(); }, [call]);
  useEffect(() => { if (selected) settlementForm.current?.focus(); }, [selected]);
  const prepare = (id: string, action: StaffAction, preview?: LibrarySettlementIntent) => { trigger.current = document.activeElement as HTMLElement | null; void run(async () => { if (!transactions) throw new LibraryUiError('CONFIGURATION_ERROR'); const next = await transactions.prepare(id, action, preview); if (active.current) { setIntent(preview ?? null); setCall(next); } }); };
  const startSettlement = (loan: LibraryLoan, outcome: 'RETURNED' | 'LOST') => { previewVersion.current++; trigger.current = document.activeElement as HTMLElement | null; setSelected({ loan, outcome }); setReason(''); setCondition('GOOD'); setRepair('0'); setLostConfirmed(false); };
  const title = (id: string) => books.find(b => b.bookId === id)?.title ?? id;
  return <>
    <section className="surface-panel library-section" aria-label="Đăng nhập thủ thư" aria-busy={busy}><h2>Đăng nhập thủ thư</h2><p>Chữ ký đăng nhập xác nhận ví, không chuyển tiền.</p>
      {!authenticated ? <button type="button" className="primary-cta-btn" disabled={busy || !wallet.address || wallet.chainId !== BigInt(20261)} onClick={() => void run(async () => { await signIn(api, wallet.address!, (a, m) => controller.signMessage(a, m)); await refresh(); })}>Ký đăng nhập thủ thư</button> : <div className="library-actions"><span className="network-pill">Đã đăng nhập thủ thư</span><button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(refresh)}>Làm mới trạng thái</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(async () => { await api.request('/api/auth/logout', {}); clear(); })}>Đăng xuất</button></div>}
      {deployment?.status === 'deployed' ? <p>Escrow <code>{deployment.escrow.address}</code></p> : <p className="wallet-warning">Chưa có manifest thư viện đã xác minh.</p>}{busy && <p role="status">Đang xử lý…</p>}{error && <p id="staff-error" className="error-panel" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</section>
    {authenticated && <>
      {call && <section ref={review} tabIndex={-1} className="surface-panel library-review" aria-label="Kiểm tra trước khi ký"><h2>{labels[call.action as StaffAction]} · kiểm tra trước khi ký</h2><dl className="library-details"><dt>Ví ký</dt><dd><code>{wallet.address}</code></dd><dt>Mạng</dt><dd>IntraCampus · 20261</dd><dt>Escrow</dt><dd><code>{call.transaction.to}</code></dd><dt>Mã yêu cầu</dt><dd><code>{call.requestId}</code></dd><dt>Người nhận</dt><dd><code>{call.recipient}</code></dd><dt>Số tiền gửi</dt><dd>{money(call.amountWei)} + gas</dd></dl>
        {call.action === 'reject' && <p>Cọc sẽ hoàn về ví người mượn: {money(call.refundWei)}.</p>}
        {intent && <><p>Người mượn: <code>{intent.borrower}</code> · Treasury: <code>{intent.treasury}</code></p><p>Thời điểm chain: {date(intent.chainTime)}</p><SettlementDetails settlement={intent.preview} /><p>Trạng thái chỉ hoàn tất sau khi event được xác minh.</p></>}
        <div className="library-actions"><button type="button" className="primary-cta-btn" disabled={busy || !wallet.canProceed} onClick={() => void run(async () => { try { await transactions!.send(call); setNotice('Đã gửi hoặc đối chiếu. Chờ bằng chứng event được xác minh.'); } finally { setCall(null); setIntent(null); await refresh(); } })}>Xác nhận và mở ví</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => { setCall(null); setIntent(null); trigger.current?.focus(); }}>Hủy</button></div></section>}
      <section className="surface-panel library-section" aria-label="Hàng chờ duyệt"><h2>Yêu cầu chờ duyệt</h2>{loading ? <p>Đang tải…</p> : requests.length === 0 ? <p>Không có yêu cầu chờ duyệt.</p> : requests.map(r => { const tx = r.transactions.find(t => t.action === 'deposit' && t.status === 'CONFIRMED' && t.proof?.eventName === 'DepositReceived' && t.proof.requestId === r.requestId && t.proof.txHash === t.txHash && deployment?.status === 'deployed' && same(t.proof.contractAddress, deployment.escrow.address)); return <article className="surface-panel library-section" aria-label={`Yêu cầu ${r.requestId}`} key={r.requestId}><h3>{title(r.bookId)}</h3><p>Mã yêu cầu: <code>{r.requestId}</code></p><p>Người mượn: <code>{tx?.proof?.borrower ?? 'Chưa có bằng chứng hợp lệ'}</code></p><p>Trạng thái: {r.status} · Hạn duyệt: {date(r.approvalDeadline)} · Cọc: {r.depositWei ? money(r.depositWei) : '—'}</p><div className="library-actions">{r.status === 'PENDING_APPROVAL' && <button type="button" className="primary-cta-btn" disabled={busy || !tx || !wallet.canProceed} onClick={() => prepare(r.requestId, 'approve')}>Duyệt</button>}<button type="button" className="secondary-btn" disabled={busy || !tx || !wallet.canProceed} onClick={() => prepare(r.requestId, 'reject')}>Từ chối</button></div></article>; })}</section>
      <section className="surface-panel library-section" aria-label="Khoản mượn"><h2>Khoản mượn và sách trả</h2>{loans.length === 0 ? <p>Không có khoản mượn.</p> : loans.map(l => <article className="surface-panel library-section" aria-label={`Khoản mượn ${l.loanId}`} key={l.loanId}><h3>{title(l.bookId)}</h3><p>Mã: <code>{l.loanId}</code> · Người mượn: <code>{l.borrower}</code></p><p>{l.status} · Hạn trả: {date(l.dueAt)} · Yêu cầu trả: {date(l.returnRequestedAt)} · Nhận sách: {date(l.returnReceivedAt)}</p>{l.settlement && <SettlementDetails settlement={l.settlement} />}<div className="library-actions">{['ACTIVE','RETURN_REQUESTED'].includes(l.status) && l.returnReceivedAt === null && <><button type="button" className="secondary-btn" disabled={busy || !wallet.canProceed} onClick={() => prepare(l.requestId, 'confirmReturn')}>Xác nhận nhận sách</button><button type="button" className="secondary-btn" disabled={busy || !wallet.canProceed} onClick={() => startSettlement(l, 'LOST')}>Báo mất</button></>}{l.status === 'SETTLEMENT_PENDING' && l.returnReceivedAt !== null && <button type="button" className="primary-cta-btn" disabled={busy || !wallet.canProceed} onClick={() => startSettlement(l, 'RETURNED')}>Quyết toán trả</button>}</div></article>)}</section>
      {selected && <section ref={settlementForm} tabIndex={-1} className="surface-panel library-section" aria-label="Thông tin quyết toán"><h2>{selected.outcome === 'RETURNED' ? 'Quyết toán sách trả' : 'Quyết toán sách mất'}</h2><p>{title(selected.loan.bookId)} · <code>{selected.loan.borrower}</code></p><form onSubmit={e => { e.preventDefault(); if (operation.current) return; previewInFlight.current = true; const abort = new AbortController(); previewAbort.current = abort; const version = ++previewVersion.current; const current = () => active.current && version === previewVersion.current; void run(async () => { const why = reason.trim(); if (!why) throw new LibraryUiError('VALIDATION_ERROR'); let input: LibrarySettlementIntentRequest; if (selected.outcome === 'LOST') { if (!lostConfirmed) throw new LibraryUiError('VALIDATION_ERROR'); input = { outcome: 'LOST', reason: why }; } else { const amount = decimalWei(repair); if ((condition === 'DAMAGED') !== (BigInt(amount) > BigInt(0))) throw new LibraryUiError('INVALID_AMOUNT'); input = { outcome: 'RETURNED', condition, reason: why, repairRequestedWei: amount }; } if (!transactions || !wallet.address) throw new LibraryUiError('CONFIGURATION_ERROR'); if (!navigator.locks) throw new LibraryUiError('LOCK_UNAVAILABLE'); const action = selected.outcome === 'RETURNED' ? 'return' : 'settle'; await navigator.locks.request(transactions.key(selected.loan.requestId, action), { signal: abort.signal }, async () => { if (!current()) return; const journal = transactions.journal(selected.loan.requestId, action); if (journal && !['confirmed','reverted'].includes(journal.phase)) throw new LibraryUiError('RECOVERY_REQUIRED'); await waitForPreview(api.session(wallet.address!, 'LIBRARIAN'), abort.signal); if (!current()) return; const request = await waitForPreview(api.getRequest(selected.loan.requestId), abort.signal); if (!current()) return; if (request.transactions.some(tx => tx.action === action && ['UNKNOWN','SUBMITTED'].includes(tx.status))) throw new LibraryUiError('RECOVERY_REQUIRED'); const result = await waitForPreview(api.settlementIntent(selected.loan.loanId, input), abort.signal); if (!current()) return; const next = await waitForPreview(transactions.prepare(selected.loan.requestId, action, result, input.outcome === 'RETURNED' ? input.repairRequestedWei : undefined), abort.signal); if (current()) { setIntent(result); setCall(next); setSelected(null); } }); }, current); }}>
        {selected.outcome === 'RETURNED' ? <><label>Tình trạng sách <select value={condition} onChange={e => setCondition(e.target.value as 'GOOD' | 'DAMAGED')}><option value="GOOD">Tốt</option><option value="DAMAGED">Hư hỏng</option></select></label><label>Phí sửa chữa (CAMPUS) <input inputMode="decimal" value={repair} aria-invalid={!!error} aria-describedby={error ? 'staff-error' : undefined} onChange={e => setRepair(e.target.value)} /></label></> : <label><input type="checkbox" checked={lostConfirmed} required aria-invalid={!!error} aria-describedby={error ? 'staff-error' : undefined} onChange={e => setLostConfirmed(e.target.checked)} /> Tôi xác nhận chưa nhận lại sách vật lý</label>}
        <label>Lý do <textarea value={reason} onChange={e => setReason(e.target.value)} required aria-invalid={!!error} aria-describedby={error ? 'staff-error' : undefined} /></label><div className="library-actions"><button className="primary-cta-btn" disabled={busy} type="submit">Xem quyết toán</button><button className="secondary-btn" type="button" onClick={() => { previewVersion.current++; if (previewInFlight.current) { previewAbort.current?.abort(); previewAbort.current = null; operationVersion.current++; operation.current = false; previewInFlight.current = false; setBusy(false); setLoading(false); } setSelected(null); trigger.current?.focus(); }}>Hủy</button></div></form></section>}
      <section className="surface-panel library-section" aria-label="Đối chiếu giao dịch"><h2>Đối chiếu giao dịch</h2>{journals.length === 0 ? <p>Không có giao dịch cần đối chiếu.</p> : journals.map(j => <Recovery key={`${j.requestId}:${j.action}`} journal={j} api={api} escrow={deployment?.status === 'deployed' ? deployment.escrow.address : ''} busy={busy} onRecover={hash => void run(async () => { await transactions!.reconcile(j.requestId, j.action as StaffAction, hash); await refresh(); setNotice('Đã đối chiếu giao dịch.'); })} />)}</section>
    </>}
  </>;
}
function Recovery({journal, api, escrow, busy, onRecover}: {journal: LibraryJournal; api: LibraryApi; escrow: string; busy: boolean; onRecover: (hash?: string) => void}) {
  const [hash, setHash] = useState('');
  const [request, setRequest] = useState<LibraryRequest | null>(null);
  useEffect(() => { let alive = true; void api.getRequest(journal.requestId).then(r => { if (alive) setRequest(r); }).catch(() => { if (alive) setRequest(null); }); return () => { alive = false; }; }, [api, journal.requestId, journal.hash, journal.phase]);
  const proof = journal.phase === 'confirmed' && journal.hash ? request?.transactions.find(t => t.action === journal.action && t.status === 'CONFIRMED' && t.proof && same(t.txHash, journal.hash!) && same(t.proof.contractAddress, escrow))?.proof : null;
  return <article><p><strong>{labels[journal.action as StaffAction] ?? journal.action}</strong> · <code>{journal.requestId}</code> · {journal.phase}</p>{journal.hash && <p>Hash: <code>{journal.hash}</code></p>}{proof && <p>Đã xác minh {proof.eventName} · Người mượn <code>{proof.borrower}</code> · Block {proof.blockNumber}</p>}{!journal.hash && <label>Hash giao dịch (nếu có) <input value={hash} onChange={e => setHash(e.target.value)} /></label>}<button className="secondary-btn" type="button" disabled={busy} onClick={() => onRecover(hash.trim() || undefined)}>Đối chiếu</button></article>;
}
