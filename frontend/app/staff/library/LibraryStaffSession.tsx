'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { campusNetwork, getLibraryDeployment, type LibraryBook, type LibraryLoan, type LibraryRequest, type LibrarySettlement, type LibrarySettlementIntent, type LibrarySettlementIntentRequest } from '@intracampus/network';
import { WalletSession, useCampusWallet } from '../../student/WalletPanel';
import { formatWalletBalance } from '../../../lib/chains';
import { LibraryApi, LibraryUiError, libraryTransactionProof, wei } from '../../../lib/library-api';
import { LibraryTransactions, type LibraryCall, type StaffAction, type LibraryJournal, type LibraryJournalEntry } from '../../../lib/library-transactions';
import { signInLibraryWallet } from '../../../lib/library-session';
import { libraryError } from '../../../lib/library';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const networkLabel = `IntraCampus · ${campusNetwork.chainId}`;
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
  const decimals = campusNetwork.nativeCurrency.decimals;
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw new LibraryUiError('INVALID_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new LibraryUiError('INVALID_AMOUNT');
  const amount = (BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'))).toString();
  if (!wei(amount)) throw new LibraryUiError('INVALID_AMOUNT');
  return amount;
}
export default function LibraryStaffSession() { return <WalletSession><Wallet /></WalletSession>; }
function Wallet() {
  const { state, controller } = useCampusWallet();
  return <div className="library-shell"><header className="library-heading"><div><span className="eyebrow">IntraCampus / Thủ thư</span><h1>Quản lý thư viện</h1><p>Duyệt yêu cầu, nhận sách và quyết toán cọc.</p></div><Link href="/student/library" className="secondary-btn">Thư viện sinh viên</Link></header>
    <section className="surface-panel library-wallet" aria-label="Ví và mạng"><div><span className="field-label">Ví đang chọn</span><p><code>{state.address ?? 'Chưa kết nối'}</code></p><span className="network-pill">{state.chainId === BigInt(campusNetwork.chainId) ? networkLabel : `Cần mạng ${networkLabel}`}</span>{state.balanceWei !== null && <p>Số dư: {formatWalletBalance(state.balanceWei)}</p>}</div><div className="library-actions">
      {!state.address && <button type="button" className="primary-cta-btn" onClick={() => void controller.connect()}>Kết nối ví Core</button>}
      {state.address && state.chainId !== BigInt(campusNetwork.chainId) && <button type="button" className="secondary-btn" onClick={() => void controller.switchNetwork()}>Chuyển mạng IntraCampus</button>}
      {state.address && <button type="button" className="secondary-btn" onClick={() => controller.disconnect()}>Ngắt kết nối</button>}</div>{state.message && <p role="status">{state.message}</p>}</section>
    <Workspace key={`${state.address}:${state.chainId}`} /></div>;
}
function Workspace() {
  const { state: wallet, controller } = useCampusWallet();
  const api = useMemo(() => new LibraryApi(), []);
  const deployment = useMemo(() => { try { return getLibraryDeployment(); } catch { return null; } }, []);
  const [authenticated, setAuthenticated] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [books, setBooks] = useState<LibraryBook[]>([]), [requests, setRequests] = useState<LibraryRequest[]>([]), [loans, setLoans] = useState<LibraryLoan[]>([]), [journals, setJournals] = useState<LibraryJournalEntry[]>([]);
  const [journalUnavailable, setJournalUnavailable] = useState(false);
  const [call, setCall] = useState<LibraryCall | null>(null), [intent, setIntent] = useState<LibrarySettlementIntent | null>(null), [selected, setSelected] = useState<{loan: LibraryLoan; outcome: 'RETURNED' | 'LOST'} | null>(null);
  const [reason, setReason] = useState(''), [condition, setCondition] = useState<'GOOD' | 'DAMAGED'>('GOOD'), [repair, setRepair] = useState('0'), [lostConfirmed, setLostConfirmed] = useState(false);
  const active = useRef(true), operation = useRef(false), operationVersion = useRef(0), previewInFlight = useRef(false), previewAbort = useRef<AbortController | null>(null), review = useRef<HTMLElement>(null), settlementForm = useRef<HTMLElement>(null), trigger = useRef<HTMLElement | null>(null), previewVersion = useRef(0);
  const transactions = useMemo(() => {
    if (!deployment || deployment.status !== 'deployed' || !wallet.address) return null;
    return new LibraryTransactions({ deployment, account: wallet.address, role: 'LIBRARIAN', api, wallet: controller, storage: {
      getItem: k => window.localStorage.getItem(k), setItem: (k, v) => window.localStorage.setItem(k, v), removeItem: k => window.localStorage.removeItem(k), key: i => window.localStorage.key(i), get length() { return window.localStorage.length; },
    }, lock: async (key, run, signal) => {
      if (!navigator.locks) throw new LibraryUiError('LOCK_UNAVAILABLE');
      await navigator.locks.request(key, signal ? { signal } : {}, run);
    } });
  }, [deployment, wallet.address, api, controller]);
  const clear = () => { previewVersion.current++; previewAbort.current?.abort(); setAuthenticated(false); setBooks([]); setRequests([]); setLoans([]); setJournals([]); setJournalUnavailable(false); setCall(null); setIntent(null); setSelected(null); };
  async function refresh() {
    if (!wallet.address || !deployment || deployment.status !== 'deployed' || !same(wallet.address, deployment.roles.librarian)) throw new LibraryUiError('FORBIDDEN');
    await api.session(wallet.address, 'LIBRARIAN');
    setLoading(true); setCall(null); setIntent(null);
    const [b, r, l] = await Promise.all([api.books(), api.requests(true), api.loans()]);
    if (!active.current) return;
    setBooks(b); setRequests(r); setLoans(l);
    try {
      setJournals(transactions?.listJournals() ?? []);
      setJournalUnavailable(false);
    } catch {
      setJournals([]);
      setJournalUnavailable(true);
    }
    setAuthenticated(true); setLoading(false);
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
  function submitSettlement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || operation.current) return;
    const { loan, outcome } = selected;
    const account = wallet.address;
    const action = outcome === 'RETURNED' ? 'return' : 'settle';
    previewInFlight.current = true;
    const abort = new AbortController();
    previewAbort.current = abort;
    const version = ++previewVersion.current;
    const current = () => active.current && version === previewVersion.current;
    void run(async () => {
      const why = reason.trim();
      if (!why || (outcome === 'LOST' && !lostConfirmed)) throw new LibraryUiError('VALIDATION_ERROR');
      const input: LibrarySettlementIntentRequest = outcome === 'LOST'
        ? { outcome, reason: why }
        : { outcome, condition, reason: why, repairRequestedWei: decimalWei(repair) };
      if (input.outcome === 'RETURNED' && ((condition === 'DAMAGED') !== (BigInt(input.repairRequestedWei) > BigInt(0)))) {
        throw new LibraryUiError('INVALID_AMOUNT');
      }
      if (!transactions || !account) throw new LibraryUiError('CONFIGURATION_ERROR');
      await transactions.withActionLock(loan.requestId, action, async () => {
        if (!current()) return;
        transactions.assertNoPending(loan.requestId, action);
        await waitForPreview(api.session(account, 'LIBRARIAN'), abort.signal);
        if (!current()) return;
        const request = await waitForPreview(api.getRequest(loan.requestId), abort.signal);
        if (!current()) return;
        transactions.assertNoPending(loan.requestId, action, request);
        const result = await waitForPreview(api.settlementIntent(loan.loanId, input), abort.signal);
        if (!current()) return;
        const repairAmount = input.outcome === 'RETURNED' ? input.repairRequestedWei : undefined;
        const next = await waitForPreview(transactions.prepare(loan.requestId, action, result, repairAmount), abort.signal);
        if (current()) { setIntent(result); setCall(next); setSelected(null); }
      }, abort.signal);
    }, current);
  }
  async function signIn() {
    if (!wallet.address || deployment?.status !== 'deployed' || !same(wallet.address, deployment.roles.librarian)) {
      throw new LibraryUiError('FORBIDDEN');
    }
    await signInLibraryWallet(wallet.address, 'LIBRARIAN', (account, message) => controller.signMessage(account, message), api.fetcher);
    await refresh();
  }
  const title = (id: string) => books.find(b => b.bookId === id)?.title ?? id;
  const escrow = deployment?.status === 'deployed' ? deployment.escrow.address : '';
  return <>
    <section className="surface-panel library-section" aria-label="Đăng nhập thủ thư" aria-busy={busy}><h2>Đăng nhập thủ thư</h2><p>Chữ ký đăng nhập xác nhận ví, không chuyển tiền.</p>
      {!authenticated ? <button type="button" className="primary-cta-btn" disabled={busy || !wallet.address || wallet.chainId !== BigInt(campusNetwork.chainId)} onClick={() => void run(signIn)}>Ký đăng nhập thủ thư</button> : <div className="library-actions"><span className="network-pill">Đã đăng nhập thủ thư</span><button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(refresh)}>Làm mới trạng thái</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(async () => { await api.request('/api/auth/logout', {}); clear(); })}>Đăng xuất</button></div>}
      {deployment?.status === 'deployed' ? <p>Escrow <code>{deployment.escrow.address}</code></p> : <p className="wallet-warning">Chưa có manifest thư viện đã xác minh.</p>}{busy && <p role="status">Đang xử lý…</p>}{error && <p id="staff-error" className="error-panel" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</section>
    {authenticated && <>
      {call && <section ref={review} tabIndex={-1} className="surface-panel library-review" aria-label="Kiểm tra trước khi ký"><h2>{labels[call.action as StaffAction]} · kiểm tra trước khi ký</h2><dl className="library-details"><dt>Ví ký</dt><dd><code>{wallet.address}</code></dd><dt>Mạng</dt><dd>{networkLabel}</dd><dt>Escrow</dt><dd><code>{call.transaction.to}</code></dd><dt>Mã yêu cầu</dt><dd><code>{call.requestId}</code></dd><dt>Người nhận</dt><dd><code>{call.recipient}</code></dd><dt>Số tiền gửi</dt><dd>{money(call.amountWei)} + gas</dd></dl>
        {call.action === 'reject' && <p>Cọc sẽ hoàn về ví người mượn: {money(call.refundWei)}.</p>}
        {intent && <><p>Người mượn: <code>{intent.borrower}</code> · Treasury: <code>{intent.treasury}</code></p><p>Thời điểm chain: {date(intent.chainTime)}</p><SettlementDetails settlement={intent.preview} /><p>Trạng thái chỉ hoàn tất sau khi event được xác minh.</p></>}
        <div className="library-actions"><button type="button" className="primary-cta-btn" disabled={busy || journalUnavailable || !wallet.canProceed} onClick={() => void run(async () => { try { await transactions!.send(call); setNotice('Đã gửi hoặc đối chiếu. Chờ bằng chứng event được xác minh.'); } finally { setCall(null); setIntent(null); await refresh(); } })}>Xác nhận và mở ví</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => { setCall(null); setIntent(null); trigger.current?.focus(); }}>Hủy</button></div></section>}
      <section className="surface-panel library-section" aria-label="Hàng chờ duyệt"><h2>Yêu cầu chờ duyệt</h2>
        {loading ? <p>Đang tải…</p> : requests.length === 0 ? <p>Không có yêu cầu chờ duyệt.</p> : requests.map(r => {
          const deposit = libraryTransactionProof(r.transactions.find(tx => tx.action === 'deposit'), r.requestId, escrow);
          const canReject = r.status === 'PENDING_APPROVAL' || (r.status === 'REJECTED_NO_COPY' && r.refundStatus === 'REFUND_DUE');
          const disabled = busy || journalUnavailable || !deposit || !wallet.canProceed;
          return <article className="surface-panel library-section" aria-label={'Yêu cầu ' + r.requestId} key={r.requestId}><h3>{title(r.bookId)}</h3>
            <p>Mã yêu cầu: <code>{r.requestId}</code></p><p>Người mượn: <code>{deposit?.borrower ?? 'Chưa có bằng chứng hợp lệ'}</code></p>
            <p>Trạng thái: {r.status} · Hạn duyệt: {date(r.approvalDeadline)} · Cọc: {r.depositWei ? money(r.depositWei) : '—'}</p>
            <div className="library-actions">
              {r.status === 'PENDING_APPROVAL' && <button type="button" className="primary-cta-btn" disabled={disabled} onClick={() => prepare(r.requestId, 'approve')}>Duyệt</button>}
              {canReject && <button type="button" className="secondary-btn" disabled={disabled} onClick={() => prepare(r.requestId, 'reject')}>Từ chối</button>}
            </div></article>;
        })}</section>
      <section className="surface-panel library-section" aria-label="Khoản mượn"><h2>Khoản mượn và sách trả</h2>{loans.length === 0 ? <p>Không có khoản mượn.</p> : loans.map(l => <article className="surface-panel library-section" aria-label={`Khoản mượn ${l.loanId}`} key={l.loanId}><h3>{title(l.bookId)}</h3><p>Mã: <code>{l.loanId}</code> · Người mượn: <code>{l.borrower}</code></p><p>{l.status} · Hạn trả: {date(l.dueAt)} · Yêu cầu trả: {date(l.returnRequestedAt)} · Nhận sách: {date(l.returnReceivedAt)}</p>{l.settlement && <SettlementDetails settlement={l.settlement} />}<div className="library-actions">{['ACTIVE','RETURN_REQUESTED'].includes(l.status) && l.returnReceivedAt === null && <><button type="button" className="secondary-btn" disabled={busy || journalUnavailable || !wallet.canProceed} onClick={() => prepare(l.requestId, 'confirmReturn')}>Xác nhận nhận sách</button><button type="button" className="secondary-btn" disabled={busy || journalUnavailable || !wallet.canProceed} onClick={() => startSettlement(l, 'LOST')}>Báo mất</button></>}{l.status === 'SETTLEMENT_PENDING' && l.returnReceivedAt !== null && <button type="button" className="primary-cta-btn" disabled={busy || journalUnavailable || !wallet.canProceed} onClick={() => startSettlement(l, 'RETURNED')}>Quyết toán trả</button>}</div></article>)}</section>
      {selected && <section ref={settlementForm} tabIndex={-1} className="surface-panel library-section" aria-label="Thông tin quyết toán"><h2>{selected.outcome === 'RETURNED' ? 'Quyết toán sách trả' : 'Quyết toán sách mất'}</h2><p>{title(selected.loan.bookId)} · <code>{selected.loan.borrower}</code></p><form onSubmit={submitSettlement}>
        {selected.outcome === 'RETURNED' ? <><label>Tình trạng sách <select value={condition} onChange={e => setCondition(e.target.value as 'GOOD' | 'DAMAGED')}><option value="GOOD">Tốt</option><option value="DAMAGED">Hư hỏng</option></select></label><label>Phí sửa chữa (CAMPUS) <input inputMode="decimal" value={repair} aria-invalid={!!error} aria-describedby={error ? 'staff-error' : undefined} onChange={e => setRepair(e.target.value)} /></label></> : <label><input type="checkbox" checked={lostConfirmed} required aria-invalid={!!error} aria-describedby={error ? 'staff-error' : undefined} onChange={e => setLostConfirmed(e.target.checked)} /> Tôi xác nhận chưa nhận lại sách vật lý</label>}
        <label>Lý do <textarea value={reason} onChange={e => setReason(e.target.value)} required aria-invalid={!!error} aria-describedby={error ? 'staff-error' : undefined} /></label><div className="library-actions"><button className="primary-cta-btn" disabled={busy} type="submit">Xem quyết toán</button><button className="secondary-btn" type="button" onClick={() => { previewVersion.current++; if (previewInFlight.current) { previewAbort.current?.abort(); previewAbort.current = null; operationVersion.current++; operation.current = false; previewInFlight.current = false; setBusy(false); setLoading(false); } setSelected(null); trigger.current?.focus(); }}>Hủy</button></div></form></section>}
      <section className="surface-panel library-section" aria-label="Đối chiếu giao dịch"><h2>Đối chiếu giao dịch</h2>
        {journalUnavailable ? <p role="alert">{libraryError(new LibraryUiError('STORAGE_BLOCKED'))}</p> : journals.length === 0 ? <p>Không có giao dịch cần đối chiếu.</p> : journals.map(j =>
          j.phase === 'unreadable' ? <article key={j.requestId + ':' + j.action} role="alert">
            <p><strong>{labels[j.action]}</strong> · <code>{j.requestId}</code></p>
            <p>Không đọc được nhật ký này. Giữ mã yêu cầu và hash để đối chiếu trước khi ký thêm.</p>
            {j.hash && <p>Hash: <code>{j.hash}</code></p>}
          </article> : <Recovery key={j.requestId + ':' + j.action} journal={j} api={api} escrow={escrow} busy={busy}
            onRecover={hash => void run(async () => { await transactions!.reconcile(j.requestId, j.action as StaffAction, hash); await refresh(); setNotice('Đã đối chiếu giao dịch.'); })} />)}
      </section>
    </>}
  </>;
}
function Recovery({journal, api, escrow, busy, onRecover}: {journal: LibraryJournal; api: LibraryApi; escrow: string; busy: boolean; onRecover: (hash?: string) => void}) {
  const [hash, setHash] = useState('');
  const [request, setRequest] = useState<LibraryRequest | null>(null);
  useEffect(() => { let alive = true; void api.getRequest(journal.requestId).then(r => { if (alive) setRequest(r); }).catch(() => { if (alive) setRequest(null); }); return () => { alive = false; }; }, [api, journal.requestId, journal.hash, journal.phase]);
  const deposit = libraryTransactionProof(request?.transactions.find(tx => tx.action === 'deposit'), journal.requestId, escrow);
  const tx = request?.transactions.find(t => t.action === journal.action && journal.hash && same(t.txHash, journal.hash));
  const proof = journal.phase === 'confirmed' && deposit ? libraryTransactionProof(tx, journal.requestId, escrow, deposit.borrower) : null;
  return <article><p><strong>{labels[journal.action as StaffAction] ?? journal.action}</strong> · <code>{journal.requestId}</code> · {journal.phase}</p>{journal.hash && <p>Hash: <code>{journal.hash}</code></p>}{proof && <p>Đã xác minh {proof.eventName} · Người mượn <code>{proof.borrower}</code> · Block {proof.blockNumber}</p>}{!journal.hash && <label>Hash giao dịch (nếu có) <input value={hash} onChange={e => setHash(e.target.value)} /></label>}<button className="secondary-btn" type="button" disabled={busy} onClick={() => onRecover(hash.trim() || undefined)}>Đối chiếu</button></article>;
}
