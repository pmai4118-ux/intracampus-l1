'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CAMPUS_CHAIN_ID, campusNetwork, getLibraryDeployment, type LibraryBook, type LibraryLoan, type LibraryRequest, type LibrarySettlement, type LibrarySettlementIntent, type LibrarySettlementIntentRequest } from '@intracampus/network';
import { WalletSession, useCampusWallet } from '../../student/WalletPanel';
import { formatWalletBalance } from '../../../lib/chains';
import { LibraryApi, LibraryUiError, libraryTransactionProof, wei } from '../../../lib/library-api';
import { LibraryTransactions, type LibraryCall, type StaffAction, type LibraryJournal, type LibraryJournalEntry } from '../../../lib/library-transactions';
import { fetchRuntimeWalletConfig } from '../../../lib/runtime-config';
import { signInLibraryWallet } from '../../../lib/library-session';
import { libraryError, libraryLabels, libraryJournalLabel, libraryJournalHint } from '../../../lib/library';
import LibraryWalletSummary from '../../student/library/LibraryWalletSummary';
import PageHeading from '../../components/PageHeading';
import HashChip from '../../components/HashChip';
import { demoLibraryBooks, demoStaffLoans, demoStaffRequests } from '../../demo-fixtures';
import {
  PaginationBar,
  StaffCatalogInventory,
  StaffEscrowKpiStrip,
  StaffLoansWorkbench,
  StaffQueuePanel,
  StaffSearchToolbar,
} from './StaffWorkbenchPanels';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function matchesStaffQuery(
  query: string,
  book: LibraryBook | undefined,
  fields: Array<string | null | undefined>,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (book) {
    if (
      book.title.toLowerCase().includes(q) ||
      book.author.toLowerCase().includes(q) ||
      (book.isbn ?? '').toLowerCase().includes(q) ||
      book.bookId.toLowerCase().includes(q)
    ) {
      return true;
    }
  }
  return fields.some(val => Boolean(val && val.toLowerCase().includes(q)));
}
const networkLabel = `IntraCampus · ${campusNetwork.chainId}`;
const money = (s: string) => formatWalletBalance(BigInt(s));
const date = (s: number | null) => s === null ? '—' : new Date(s * 1000).toLocaleString('vi-VN');
const labels: Record<StaffAction, string> = { approve: 'Duyệt mượn', reject: 'Từ chối mượn', confirmReturn: 'Xác nhận nhận sách', return: 'Quyết toán trả', settle: 'Báo mất' };
const amountLabels: Record<string, string> = { lateFeeWei: 'Phí trễ', repairFeeWei: 'Phí sửa chữa', overdueForfeitWei: 'Cọc giữ do quá hạn', totalRetainedWei: 'Tổng giữ lại', refundWei: 'Hoàn cho người mượn', replacementPriceWei: 'Giá thay thế', shortfallWei: 'Sinh viên cần trả thêm' };
function SettlementDetails({ settlement }: { settlement: LibrarySettlement }) {
  const componentKeys = settlement.outcome === 'RETURNED'
    ? (['lateFeeWei', 'repairFeeWei', 'overdueForfeitWei'] as const)
    : (['replacementPriceWei'] as const);
  const summaryKeys = settlement.outcome === 'RETURNED'
    ? (['totalRetainedWei', 'refundWei'] as const)
    : (['totalRetainedWei', 'refundWei', 'shortfallWei'] as const);
  const record = settlement as unknown as Record<string, string>;
  return <div className="settlement-breakdown-wrap">
    <p className="settlement-status-line">Kết quả: <strong>{settlement.outcome === 'RETURNED' ? 'Sách trả' : 'Sách mất'}</strong>{settlement.outcome === 'RETURNED' && <> · Nhận sách lúc: <span className="tabular-value">{date(settlement.returnedAt)}</span> · {settlement.maintenanceRequired ? 'Cần bảo trì' : 'Không cần bảo trì'}</>}</p>
    <dl className="settlement-components-grid">
      {componentKeys.map(k => (
        <div key={k}><dt>{amountLabels[k] ?? k}</dt><dd className="tabular-value">{money(String(record[k]))}</dd></div>
      ))}
    </dl>
    <dl className="settlement-summary-highlight">
      {summaryKeys.map(k => (
        <div key={k} className={k === 'refundWei' ? 'summary-refund-box' : k === 'shortfallWei' ? 'summary-shortfall-box' : 'summary-retained-box'}>
          <dt>{amountLabels[k] ?? k}</dt>
          <dd className="tabular-value">{money(String(record[k]))}</dd>
        </div>
      ))}
    </dl>
  </div>;
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
  const { state } = useCampusWallet();
  const [mode, setMode] = useState<'live' | 'demo'>('live');
  return <div className="library-shell">
    <PageHeading eyebrow="KHÔNG GIAN THỦ THƯ" title="Quản lý thư viện" description="Duyệt yêu cầu, nhận sách và quyết toán cọc." icon="shield">
      <div className="mode-switch-wrapper">
        <span className="mode-switch-kicker">
          <span className={`mode-status-dot ${mode === 'live' ? 'dot-live' : 'dot-demo'}`} aria-hidden="true" />
          {mode === 'live' ? `Avalanche L1 · Chain ${CAMPUS_CHAIN_ID}` : 'Bản minh họa'}
        </span>
        <div className="student-mode-switch" role="group" aria-label="Chế độ bàn thủ thư">
          <button type="button" className="secondary-btn" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>Thủ thư thật</button>
          <button type="button" className="secondary-btn" aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}>Xem bản minh họa</button>
        </div>
      </div>
      <Link href="/staff/canteen" className="secondary-btn">Quầy bếp nhà ăn</Link>
      <Link href="/student/library" className="secondary-btn">Thư viện sinh viên</Link>
    </PageHeading>
    {mode === 'live' ? <>
      <LibraryWalletSummary />
      <Workspace key={`${state.address}:${state.chainId}`} onOpenDemo={() => setMode('demo')} />
    </> : <StaffDemoWorkspace onBackToLive={() => setMode('live')} />}
  </div>;
}
function Workspace({ onOpenDemo }: { onOpenDemo: () => void }) {
  const { state: wallet, controller } = useCampusWallet();
  const api = useMemo(() => new LibraryApi(), []);
  const deployment = useMemo(() => { try { return getLibraryDeployment(); } catch { return null; } }, []);
  const [runtimeLibrarian, setRuntimeLibrarian] = useState<string | null>(null);
  const [runtimeTreasury, setRuntimeTreasury] = useState<string | null>(null);
  const [runtimeLoaded, setRuntimeLoaded] = useState(false);
  const activeLibrarian = runtimeLibrarian ?? (deployment?.status === 'deployed' ? deployment.roles.librarian : '');
  const activeTreasury = runtimeTreasury ?? (deployment?.status === 'deployed' ? deployment.treasury : '');
  const activeLibrarianRef = useRef(activeLibrarian);
  activeLibrarianRef.current = activeLibrarian;
  useEffect(() => {
    let mounted = true;
    const abort = new AbortController();
    void fetchRuntimeWalletConfig(fetch, abort.signal).then((cfg) => {
      if (!mounted) return;
      if (cfg?.libraryLibrarian) setRuntimeLibrarian(cfg.libraryLibrarian);
      if (cfg?.libraryTreasury) setRuntimeTreasury(cfg.libraryTreasury);
      setRuntimeLoaded(true);
    });
    return () => { mounted = false; abort.abort(); };
  }, []);
  const [authenticated, setAuthenticated] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [books, setBooks] = useState<LibraryBook[]>([]), [requests, setRequests] = useState<LibraryRequest[]>([]), [loans, setLoans] = useState<LibraryLoan[]>([]), [journals, setJournals] = useState<LibraryJournalEntry[]>([]);
  const [journalUnavailable, setJournalUnavailable] = useState(false);
  const [call, setCall] = useState<LibraryCall | null>(null), [intent, setIntent] = useState<LibrarySettlementIntent | null>(null), [selected, setSelected] = useState<{loan: LibraryLoan; outcome: 'RETURNED' | 'LOST'} | null>(null);
  const [view, setView] = useState<'all' | 'queue' | 'loans' | 'catalog' | 'recovery'>('all');
  const [search, setSearch] = useState('');
  const [serverBorrowerFilter, setServerBorrowerFilter] = useState<string | null>(null);
  const serverBorrowerRef = useRef<string | null>(null);
  const [journalFilter, setJournalFilter] = useState<'all' | 'attention' | 'confirmed'>('all');
  const [journalPage, setJournalPage] = useState(1);
  const [journalPageSize, setJournalPageSize] = useState(20);
  const [reason, setReason] = useState(''), [condition, setCondition] = useState<'GOOD' | 'DAMAGED'>('GOOD'), [repair, setRepair] = useState('0'), [lostConfirmed, setLostConfirmed] = useState(false);
  const active = useRef(true), operation = useRef(false), operationVersion = useRef(0), previewInFlight = useRef(false), previewAbort = useRef<AbortController | null>(null), review = useRef<HTMLElement>(null), settlementForm = useRef<HTMLElement>(null), trigger = useRef<HTMLElement | null>(null), previewVersion = useRef(0);
  const transactions = useMemo(() => {
    if (!deployment || deployment.status !== 'deployed' || !wallet.address) return null;
    return new LibraryTransactions({ deployment, account: wallet.address, role: 'LIBRARIAN', librarianOverride: activeLibrarian || null, treasuryOverride: activeTreasury || null, api, wallet: controller, storage: {
      getItem: k => window.localStorage.getItem(k), setItem: (k, v) => window.localStorage.setItem(k, v), removeItem: k => window.localStorage.removeItem(k), key: i => window.localStorage.key(i), get length() { return window.localStorage.length; },
    }, lock: async (key, run, signal) => {
      if (!navigator.locks) throw new LibraryUiError('LOCK_UNAVAILABLE');
      await navigator.locks.request(key, signal ? { signal } : {}, run);
    } });
  }, [deployment, wallet.address, activeLibrarian, activeTreasury, api, controller]);
  const clear = () => {
    previewVersion.current++;
    previewAbort.current?.abort();
    serverBorrowerRef.current = null;
    setServerBorrowerFilter(null);
    setAuthenticated(false);
    setBooks([]);
    setRequests([]);
    setLoans([]);
    setJournals([]);
    setJournalUnavailable(false);
    setCall(null);
    setIntent(null);
    setSelected(null);
  };
  async function refresh(walletOverride?: string | null) {
    const librarianAddr = activeLibrarianRef.current;
    if (!wallet.address || !deployment || deployment.status !== 'deployed' || !librarianAddr || !same(wallet.address, librarianAddr)) throw new LibraryUiError('FORBIDDEN');
    await api.session(wallet.address, 'LIBRARIAN');
    setLoading(true); setCall(null); setIntent(null);
    const activeFilter = walletOverride !== undefined ? walletOverride : serverBorrowerRef.current;
    const [b, r, l] = await Promise.all([api.books(), api.requests(true), api.loans(activeFilter ?? undefined)]);
    if (!active.current) return;
    if (walletOverride !== undefined) {
      serverBorrowerRef.current = walletOverride;
      setServerBorrowerFilter(walletOverride);
    }
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
  useEffect(() => { active.current = true; if (wallet.address && runtimeLoaded) void run(refresh); const focus = () => { if (wallet.address && runtimeLoaded && !operation.current) void run(refresh); }; window.addEventListener('focus', focus); return () => { active.current = false; previewAbort.current?.abort(); window.removeEventListener('focus', focus); }; /* remounted per account */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeLoaded, activeLibrarian]);
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
    if (!wallet.address || deployment?.status !== 'deployed' || !activeLibrarian || !same(wallet.address, activeLibrarian)) {
      throw new LibraryUiError('FORBIDDEN');
    }
    await signInLibraryWallet(wallet.address, 'LIBRARIAN', (account, message) => controller.signMessage(account, message), api.fetcher);
    await refresh();
  }
  const bookMap = useMemo(() => new Map<string, LibraryBook>(books.map(b => [b.bookId, b])), [books]);
  const title = (id: string) => bookMap.get(id)?.title ?? id;
  const escrow = deployment?.status === 'deployed' ? deployment.escrow.address : '';
  const wrongRoleWallet = Boolean(runtimeLoaded && wallet.address && deployment?.status === 'deployed' && activeLibrarian && !same(wallet.address, activeLibrarian));
  const filteredBooks = useMemo(() => books.filter(b => matchesStaffQuery(search, b, [])), [books, search]);
  const filteredRequests = useMemo(
    () =>
      requests.filter(r => {
        const deposit = libraryTransactionProof(r.transactions.find(tx => tx.action === 'deposit'), r.requestId, escrow);
        return matchesStaffQuery(search, bookMap.get(r.bookId), [r.requestId, deposit?.borrower]);
      }),
    [requests, search, bookMap, escrow],
  );
  const filteredLoans = useMemo(
    () => loans.filter(l => matchesStaffQuery(search, bookMap.get(l.bookId), [l.loanId, l.requestId, l.borrower])),
    [loans, search, bookMap],
  );
  const filteredJournals = useMemo(
    () =>
      journals.filter(j => {
        if (journalFilter === 'confirmed' && j.phase !== 'confirmed') return false;
        if (journalFilter === 'attention' && j.phase === 'confirmed') return false;
        return matchesStaffQuery(search, undefined, [j.requestId, j.hash, labels[j.action as StaffAction]]);
      }),
    [journals, journalFilter, search],
  );
  const effectiveJournalSize = journalPageSize <= 0 ? Math.max(1, filteredJournals.length) : journalPageSize;
  const safeJournalPage = Math.min(journalPage, Math.max(1, Math.ceil(filteredJournals.length / effectiveJournalSize)));
  const pagedJournals = filteredJournals.slice((safeJournalPage - 1) * effectiveJournalSize, safeJournalPage * effectiveJournalSize);
  const journalAttentionCount = journals.filter(j => j.phase !== 'confirmed').length;

  return <>
    <section className="surface-panel library-section" aria-label="Đăng nhập thủ thư" aria-busy={busy}><h2>Đăng nhập thủ thư</h2><p>Chữ ký đăng nhập xác nhận ví, không chuyển tiền.</p>
      {wrongRoleWallet ? <p className="wallet-warning">Ví đang kết nối không trùng địa chỉ thủ thư đang hoạt động (<code>{activeLibrarian}</code>). Hãy đổi tài khoản trong Core trước khi ký.</p> : null}
      {!authenticated ? <div className="library-actions">
        <button type="button" className="primary-cta-btn" disabled={busy || !wallet.address || wallet.chainId !== BigInt(campusNetwork.chainId)} onClick={() => void run(signIn)}>Ký đăng nhập thủ thư</button>
        <button type="button" className="secondary-btn" onClick={onOpenDemo}>Xem thử bàn điều phối thủ thư mẫu</button>
      </div> : <div className="library-actions"><span className="network-pill pill-ok">Đã đăng nhập thủ thư</span><button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(() => refresh())}>Làm mới trạng thái</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(async () => { await api.request('/api/auth/logout', {}); clear(); })}>Đăng xuất</button></div>}
      {deployment?.status === 'deployed' ? <p className="metric-note">Escrow <HashChip value={deployment.escrow.address} copyLabel="Sao chép địa chỉ escrow" /></p> : <p className="wallet-warning">Chưa có manifest thư viện đã xác minh.</p>}{busy && <p role="status">Đang xử lý…</p>}{error && <p id="staff-error" className="error-panel" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</section>
    {authenticated && <>
      <StaffEscrowKpiStrip books={books} requests={requests} loans={loans} onSelectTab={tab => setView(tab)} />
      <StaffSearchToolbar
        search={search}
        onSearch={setSearch}
        serverWalletFilter={serverBorrowerFilter}
        onApplyServerWallet={nextWallet => void run(() => refresh(nextWallet))}
        busy={busy}
      />
      <div className="library-filter-bar" role="group" aria-label="Bộ lọc nghiệp vụ thủ thư">
        {([
          ['all', 'Tất cả'],
          ['queue', `Chờ duyệt (${filteredRequests.length})`],
          ['loans', `Khoản mượn (${filteredLoans.length})`],
          ['catalog', `Kho sách (${filteredBooks.length})`],
          ['recovery', `Đối chiếu (${filteredJournals.length})`],
        ] as const).map(([key, label]) => (
          <button key={key} type="button" className={`seg-btn ${view === key ? 'active' : ''}`} aria-pressed={view === key} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </div>
      {call && <section ref={review} tabIndex={-1} className="surface-panel library-review" aria-label="Kiểm tra trước khi ký"><h2>{labels[call.action as StaffAction]} · kiểm tra trước khi ký</h2><dl className="library-details"><dt>Ví ký</dt><dd><HashChip value={wallet.address ?? ''} copyLabel="Sao chép ví thủ thư" /></dd><dt>Mạng</dt><dd>{networkLabel}</dd><dt>Escrow</dt><dd><HashChip value={call.transaction.to} copyLabel="Sao chép địa chỉ escrow" /></dd><dt>Mã yêu cầu</dt><dd><HashChip value={call.requestId} copyLabel="Sao chép mã yêu cầu" /></dd><dt>Người nhận</dt><dd><HashChip value={call.recipient} copyLabel="Sao chép địa chỉ người nhận" /></dd><dt>Số tiền gửi</dt><dd>{money(call.amountWei)} + gas</dd></dl>
        {call.action === 'reject' && <p>Cọc sẽ hoàn về ví người mượn: {money(call.refundWei)}.</p>}
        {intent && <><p>Người mượn: <code>{intent.borrower}</code> · Treasury: <code>{intent.treasury}</code></p><p>Thời điểm chain: {date(intent.chainTime)}</p><SettlementDetails settlement={intent.preview} /><p>Trạng thái chỉ hoàn tất sau khi event được xác minh.</p></>}
        <div className="library-actions"><button type="button" className="primary-cta-btn" disabled={busy || journalUnavailable || !wallet.canProceed} onClick={() => void run(async () => { try { await transactions!.send(call); setNotice('Đã gửi hoặc đối chiếu. Chờ bằng chứng event được xác minh.'); } finally { setCall(null); setIntent(null); await refresh(); } })}>Xác nhận và mở ví</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => { setCall(null); setIntent(null); trigger.current?.focus(); }}>Hủy</button></div></section>}
      {selected && <section ref={settlementForm} tabIndex={-1} className="surface-panel library-section library-review" aria-label="Thông tin quyết toán"><h2>{selected.outcome === 'RETURNED' ? 'Quyết toán sách trả' : 'Quyết toán sách mất'}</h2><p>{title(selected.loan.bookId)} · <HashChip value={selected.loan.borrower} copyLabel="Sao chép ví người mượn" /></p>{error ? <p className="error-panel">{error}</p> : null}<form onSubmit={submitSettlement}>
        {selected.outcome === 'RETURNED' ? <><label>Tình trạng sách <select value={condition} onChange={e => setCondition(e.target.value as 'GOOD' | 'DAMAGED')}><option value="GOOD">Tốt</option><option value="DAMAGED">Hư hỏng</option></select></label><label>Phí sửa chữa (CAMPUS) <input inputMode="decimal" value={repair} aria-invalid={!!error} aria-describedby={error ? 'staff-error' : undefined} onChange={e => setRepair(e.target.value)} /></label></> : <label><input type="checkbox" checked={lostConfirmed} required aria-invalid={!!error} aria-describedby={error ? 'staff-error' : undefined} onChange={e => setLostConfirmed(e.target.checked)} /> Tôi xác nhận chưa nhận lại sách vật lý</label>}
        <label>Lý do <textarea value={reason} onChange={e => setReason(e.target.value)} required aria-invalid={!!error} aria-describedby={error ? 'staff-error' : undefined} /></label><div className="library-actions"><button className="primary-cta-btn" disabled={busy} type="submit">Xem quyết toán</button><button className="secondary-btn" type="button" onClick={() => { previewVersion.current++; if (previewInFlight.current) { previewAbort.current?.abort(); previewAbort.current = null; operationVersion.current++; operation.current = false; previewInFlight.current = false; setBusy(false); setLoading(false); } setSelected(null); trigger.current?.focus(); }}>Hủy</button></div></form></section>}
      {(view === 'all' || view === 'queue') && (
        <StaffQueuePanel
          requests={filteredRequests}
          titleOf={title}
          escrow={escrow}
          loading={loading}
          busy={busy}
          journalUnavailable={journalUnavailable}
          walletReady={wallet.canProceed}
          onApprove={r => prepare(r.requestId, 'approve')}
          onReject={r => prepare(r.requestId, 'reject')}
        />
      )}
      {(view === 'all' || view === 'loans') && (
        <StaffLoansWorkbench
          loans={filteredLoans}
          titleOf={title}
          busy={busy}
          journalUnavailable={journalUnavailable}
          walletReady={wallet.canProceed}
          renderSettlementDetails={s => <SettlementDetails settlement={s} />}
          onConfirmReturn={l => prepare(l.requestId, 'confirmReturn')}
          onReportLost={l => startSettlement(l, 'LOST')}
          onSettleReturn={l => startSettlement(l, 'RETURNED')}
        />
      )}
      {view === 'catalog' && <StaffCatalogInventory books={filteredBooks} />}
      {(view === 'all' || view === 'recovery') && (
        <section className="surface-panel library-section" aria-label="Đối chiếu giao dịch">
          <div className="staff-section-top">
            <div>
              <span className="eyebrow">03 / Nhật ký trình duyệt</span>
              <h2>Đối chiếu giao dịch ({journals.length})</h2>
            </div>
            {journals.length > 0 ? (
              <div className="segmented-row" role="group" aria-label="Lọc nhật ký đối chiếu">
                <button type="button" className={`seg-btn ${journalFilter === 'all' ? 'active' : ''}`} aria-pressed={journalFilter === 'all'} onClick={() => { setJournalFilter('all'); setJournalPage(1); }}>
                  Tất cả ({journals.length})
                </button>
                <button type="button" className={`seg-btn ${journalFilter === 'attention' ? 'active' : ''}`} aria-pressed={journalFilter === 'attention'} onClick={() => { setJournalFilter('attention'); setJournalPage(1); }}>
                  Cần kiểm tra ({journalAttentionCount})
                </button>
                <button type="button" className={`seg-btn ${journalFilter === 'confirmed' ? 'active' : ''}`} aria-pressed={journalFilter === 'confirmed'} onClick={() => { setJournalFilter('confirmed'); setJournalPage(1); }}>
                  Đã xác minh ({journals.length - journalAttentionCount})
                </button>
              </div>
            ) : null}
          </div>
          {journalUnavailable ? (
            <p role="alert">{libraryError(new LibraryUiError('STORAGE_BLOCKED'))}</p>
          ) : filteredJournals.length === 0 ? (
            <p>Không có giao dịch cần đối chiếu.</p>
          ) : (
            <>
              <div className="library-list">
                {pagedJournals.map(j =>
                  j.phase === 'unreadable' ? (
                    <article key={j.requestId + ':' + j.action} className="library-record error-panel" role="alert">
                      <p><strong>{labels[j.action]}</strong> · <HashChip value={j.requestId} copyLabel="Sao chép mã yêu cầu" /></p>
                      <p>Không đọc được nhật ký này. Giữ mã yêu cầu và hash để đối chiếu trước khi ký thêm.</p>
                      <details><summary>Mã yêu cầu đầy đủ</summary><code>{j.requestId}</code>{j.hash && <p>Hash: <code>{j.hash}</code></p>}</details>
                    </article>
                  ) : (
                    <Recovery
                      key={j.requestId + ':' + j.action}
                      journal={j}
                      api={api}
                      escrow={escrow}
                      busy={busy}
                      onRecover={hash => void run(async () => { await transactions!.reconcile(j.requestId, j.action as StaffAction, hash); await refresh(); setNotice('Đã đối chiếu giao dịch.'); })}
                    />
                  ),
                )}
              </div>
              <PaginationBar
                total={filteredJournals.length}
                page={safeJournalPage}
                pageSize={journalPageSize}
                onPage={setJournalPage}
                onPageSize={setJournalPageSize}
                sizes={[20, 50, 0]}
                unitLabel="nhật ký"
              />
            </>
          )}
        </section>
      )}
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
  return <article className="library-record staff-record">
    <div className="staff-record-head">
      <div className="staff-record-main">
        <div className="staff-title-row">
          <strong>{labels[journal.action as StaffAction] ?? journal.action}</strong>
          <span className={`network-pill ${journal.phase === 'confirmed' ? 'pill-ok' : 'pill-warning'}`}>{libraryJournalLabel(journal.phase)}</span>
          {request?.refundStatus === 'REFUNDED' && <span className="network-pill pill-ok">Cọc đã được hoàn về ví người mượn</span>}
        </div>
        <p className="muted-line">{libraryJournalHint(journal.phase)}</p>
      </div>
      <div className="library-actions staff-actions-right">
        <button className="secondary-btn" type="button" disabled={busy} onClick={() => onRecover(hash.trim() || undefined)}>Đối chiếu</button>
      </div>
    </div>
    {!journal.hash && <label>Mã giao dịch từ lịch sử ví (nếu có) <input value={hash} spellCheck={false} autoComplete="off" onChange={e => setHash(e.target.value)} /></label>}
    <details><summary>Chi tiết giao dịch và biên nhận</summary><p>Mã yêu cầu <code>{journal.requestId}</code></p>
      {journal.hash && <p>Mã giao dịch <code>{journal.hash}</code></p>}
      {proof && <p>Đã xác minh {proof.eventName} · Người mượn <code>{proof.borrower}</code> · Block {proof.blockNumber}</p>}
    </details>
  </article>;
}

function StaffDemoWorkspace({ onBackToLive }: { onBackToLive: () => void }) {
  const [view, setView] = useState<'all' | 'queue' | 'loans' | 'catalog'>('all');
  const [search, setSearch] = useState('');
  const [books, setBooks] = useState<LibraryBook[]>(demoLibraryBooks);
  const [requests, setRequests] = useState<LibraryRequest[]>(demoStaffRequests);
  const [loans, setLoans] = useState<LibraryLoan[]>(demoStaffLoans);
  const [selected, setSelected] = useState<{ loan: LibraryLoan; outcome: 'RETURNED' | 'LOST' } | null>(null);
  const [condition, setCondition] = useState<'GOOD' | 'DAMAGED'>('GOOD');
  const [repair, setRepair] = useState('0');
  const [reason, setReason] = useState('Sách nguyên vẹn, đầy đủ trang');
  const [demoNotice, setDemoNotice] = useState('');

  const bookMap = useMemo(() => new Map<string, LibraryBook>(books.map(b => [b.bookId, b])), [books]);
  const title = (id: string) => bookMap.get(id)?.title ?? id;

  const filteredBooks = useMemo(() => books.filter(b => matchesStaffQuery(search, b, [])), [books, search]);
  const filteredRequests = useMemo(
    () =>
      requests.filter(r => {
        const borrower = r.transactions.find(tx => tx.action === 'deposit')?.proof?.borrower;
        return matchesStaffQuery(search, bookMap.get(r.bookId), [r.requestId, borrower]);
      }),
    [requests, search, bookMap],
  );
  const filteredLoans = useMemo(
    () => loans.filter(l => matchesStaffQuery(search, bookMap.get(l.bookId), [l.loanId, l.requestId, l.borrower])),
    [loans, search, bookMap],
  );

  function applyDemoSettlement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const { loan, outcome } = selected;
    const book = bookMap.get(loan.bookId) ?? books[0];
    const deposit = BigInt(book.depositWei);
    const replacement = BigInt(book.replacementPriceWei);

    let settlement: LibrarySettlement;
    let nextStatus: LibraryLoan['status'];
    if (outcome === 'RETURNED') {
      const repairWei = condition === 'DAMAGED' && /^(0|[1-9]\d*)(\.\d+)?$/.test(repair)
        ? BigInt(decimalWei(repair))
        : BigInt(0);
      const retained = repairWei < deposit ? repairWei : deposit;
      const refund = deposit - retained;
      settlement = {
        outcome: 'RETURNED',
        returnedAt: loan.returnReceivedAt ?? Math.floor(Date.now() / 1000),
        lateFeeWei: '0',
        repairFeeWei: retained.toString(),
        overdueForfeitWei: '0',
        totalRetainedWei: retained.toString(),
        refundWei: refund.toString(),
        maintenanceRequired: retained > BigInt(0),
      };
      nextStatus = 'RETURNED';
      if (retained === BigInt(0)) {
        setBooks(prev =>
          prev.map(b => (b.bookId === book.bookId ? { ...b, copiesAvailable: Math.min(b.copiesTotal, b.copiesAvailable + 1) } : b)),
        );
      }
    } else {
      const retained = replacement < deposit ? replacement : deposit;
      const refund = deposit - retained;
      const shortfall = replacement > deposit ? replacement - deposit : BigInt(0);
      settlement = {
        outcome: 'LOST',
        replacementPriceWei: replacement.toString(),
        totalRetainedWei: retained.toString(),
        refundWei: refund.toString(),
        shortfallWei: shortfall.toString(),
      };
      nextStatus = shortfall > BigInt(0) ? 'LOST_SHORTFALL_DUE' : 'LOST_SETTLED';
    }

    setLoans(prev => prev.map(l => l.loanId === loan.loanId ? { ...l, status: nextStatus, settlement } : l));
    setSelected(null);
    setDemoNotice(`Đã mô phỏng quyết toán (${outcome === 'RETURNED' ? 'Sách trả' : 'Báo mất'}) cho "${book.title}". Giao dịch đã chuyển xuống Sổ cái lịch sử quyết toán.`);
  }

  return <>
    <section className="demo-control-strip demo-pill-bar" aria-label="Điều khiển bản minh họa thủ thư">
      <div className="demo-pill-left">
        <span className="demo-pill-badge">
          <span className="mode-status-dot dot-demo" aria-hidden="true" />
          Bản minh họa thủ thư · Dữ liệu mẫu
        </span>
        <span className="demo-pill-summary">Thử duyệt mượn, quyết toán cọc và tra cứu sổ cái 1 dòng</span>
      </div>
      <div className="demo-pill-actions">
        <button
          type="button"
          className="secondary-btn btn-pill-sm"
          onClick={() => {
            setBooks(demoLibraryBooks);
            setRequests(demoStaffRequests);
            setLoans(demoStaffLoans);
            setSearch('');
            setSelected(null);
            setDemoNotice('Đã khôi phục toàn bộ hàng chờ, sổ cái khoản mượn và kho sách mẫu.');
          }}
        >
          Khôi phục mặc định
        </button>
        <button type="button" className="secondary-btn btn-pill-sm" onClick={onBackToLive}>Bàn thủ thư thật →</button>
      </div>
    </section>

    {demoNotice ? <p className="surface-panel" role="status">{demoNotice}</p> : null}

    <StaffEscrowKpiStrip books={books} requests={requests} loans={loans} onSelectTab={tab => setView(tab)} />
    <StaffSearchToolbar search={search} onSearch={setSearch} />

    <div className="library-filter-bar" role="group" aria-label="Bộ lọc nghiệp vụ thủ thư mẫu">
      {([
        ['all', 'Tất cả'],
        ['queue', `Chờ duyệt (${filteredRequests.length})`],
        ['loans', `Khoản mượn (${filteredLoans.length})`],
        ['catalog', `Kho sách (${filteredBooks.length})`],
      ] as const).map(([key, label]) => (
        <button key={key} type="button" className={`seg-btn ${view === key ? 'active' : ''}`} aria-pressed={view === key} onClick={() => setView(key)}>
          {label}
        </button>
      ))}
    </div>

    {selected ? (
      <section className="surface-panel library-section library-review" aria-label="Mô phỏng thông tin quyết toán">
        <span className="fixture-pill">Mô phỏng quyết toán · Dữ liệu mẫu</span>
        <h2>{selected.outcome === 'RETURNED' ? 'Quyết toán sách trả' : 'Quyết toán sách mất'}</h2>
        <p><strong>{title(selected.loan.bookId)}</strong> · Người mượn: <HashChip value={selected.loan.borrower} copyLabel="Sao chép ví người mượn" /></p>
        <form onSubmit={applyDemoSettlement}>
          {selected.outcome === 'RETURNED' ? (
            <>
              <label>Tình trạng sách <select value={condition} onChange={e => { const next = e.target.value as 'GOOD' | 'DAMAGED'; setCondition(next); if (next === 'GOOD') setRepair('0'); else if (repair === '0') setRepair('10'); }}><option value="GOOD">Tốt (Hoàn đủ 50 CAMPUS)</option><option value="DAMAGED">Hư hỏng (Khấu trừ phí sửa chữa)</option></select></label>
              <label>Phí sửa chữa (CAMPUS) <input inputMode="decimal" value={repair} disabled={condition === 'GOOD'} onChange={e => setRepair(e.target.value)} /></label>
            </>
          ) : (
            <p className="metric-note">Giá thay thế sách: <strong>{money(bookMap.get(selected.loan.bookId)?.replacementPriceWei ?? '50000000000000000000')}</strong>. Cọc giữ tối đa 50 CAMPUS; phần vượt cọc ghi nhận thành khoản thiếu.</p>
          )}
          <label>Lý do ghi biên bản <textarea value={reason} onChange={e => setReason(e.target.value)} required /></label>
          <div className="library-actions">
            <button type="submit" className="primary-cta-btn">Áp dụng quyết toán mẫu</button>
            <button type="button" className="secondary-btn" onClick={() => setSelected(null)}>Hủy</button>
          </div>
        </form>
      </section>
    ) : null}

    {(view === 'all' || view === 'queue') ? (
      <StaffQueuePanel
        requests={filteredRequests}
        titleOf={title}
        escrow=""
        loading={false}
        busy={false}
        journalUnavailable={false}
        walletReady
        demoMode
        onApprove={r => {
          const nowSec = Math.floor(Date.now() / 1000);
          const borrower = r.transactions.find(tx => tx.action === 'deposit')?.proof?.borrower ?? '0x83907f9a2685efcbb2beda057cb23a3809c8f750';
          setRequests(prev => prev.filter(item => item.requestId !== r.requestId));
          setBooks(prev =>
            prev.map(b => (b.bookId === r.bookId ? { ...b, copiesAvailable: Math.max(0, b.copiesAvailable - 1) } : b)),
          );
          setLoans(prev => [
            {
              loanId: r.requestId,
              requestId: r.requestId,
              bookId: r.bookId,
              borrower,
              status: 'ACTIVE',
              approvedAt: nowSec,
              dueAt: nowSec + 1209600,
              returnRequestedAt: null,
              returnReceivedAt: null,
              settlement: null,
            },
            ...prev,
          ]);
          setDemoNotice(`Đã mô phỏng duyệt mượn sách "${title(r.bookId)}". Khoản mượn mới đã chuyển xuống phần Đang mở.`);
        }}
        onReject={r => {
          setRequests(prev => prev.filter(item => item.requestId !== r.requestId));
          setDemoNotice(`Đã mô phỏng từ chối yêu cầu và hoàn 50 CAMPUS cho sách "${title(r.bookId)}".`);
        }}
      />
    ) : null}

    {(view === 'all' || view === 'loans') ? (
      <StaffLoansWorkbench
        loans={filteredLoans}
        titleOf={title}
        busy={false}
        journalUnavailable={false}
        walletReady
        demoMode
        renderSettlementDetails={s => <SettlementDetails settlement={s} />}
        onConfirmReturn={l => {
          const nowSec = Math.floor(Date.now() / 1000);
          setLoans(prev => prev.map(item => (item.loanId === l.loanId ? { ...item, status: 'SETTLEMENT_PENDING', returnReceivedAt: nowSec } : item)));
          setDemoNotice(`Đã xác nhận nhận lại sách vật lý "${title(l.bookId)}". Đơn đã được ghim lên đầu danh sách Chờ quyết toán.`);
        }}
        onReportLost={l => {
          setSelected({ loan: l, outcome: 'LOST' });
          setReason('Sinh viên báo thất lạc sách');
        }}
        onSettleReturn={l => {
          setSelected({ loan: l, outcome: 'RETURNED' });
          setCondition('GOOD');
          setRepair('0');
          setReason('Sách trả đúng hạn, tình trạng tốt');
        }}
      />
    ) : null}

    {(view === 'all' || view === 'catalog') ? <StaffCatalogInventory books={filteredBooks} /> : null}
  </>;
}
