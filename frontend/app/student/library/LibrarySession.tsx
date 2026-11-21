'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CAMPUS_CHAIN_ID, campusNetwork, getLibraryDeployment, type LibraryBook, type LibraryRequest, type LibraryLoan, type LibraryAccountStatus } from '@intracampus/network';
import { WalletSession, useCampusWallet } from '../WalletPanel';
import { formatWalletBalance, formatWalletBalanceCompact } from '../../../lib/chains';
import { LibraryApi, LibraryUiError, check } from '../../../lib/library-api';
import { signInLibraryStudent } from '../../../lib/library-session';
import { LibraryTransactions, type LibraryCall, type StudentAction } from '../../../lib/library-transactions';
import { fetchRuntimeWalletConfig } from '../../../lib/runtime-config';
import { libraryError, libraryLabels } from '../../../lib/library';
import LibraryCatalog from './LibraryCatalog';
import LibraryLoans from './LibraryLoans';
import LibraryRequests from './LibraryRequests';
import UnmatchedDeposits from './UnmatchedDeposits';
import LibraryWalletSummary from './LibraryWalletSummary';
import PageHeading from '../../components/PageHeading';
import HashChip from '../../components/HashChip';
import { demoLibraryBooks, demoLibraryRequests, demoStudentLibraryLoans } from '../../demo-fixtures';

function StudentLibrarySummaryStrip({
  books,
  requests,
  loans,
  onSelectTab,
}: {
  books: LibraryBook[];
  requests: LibraryRequest[];
  loans: LibraryLoan[];
  onSelectTab: (tab: 'catalog' | 'requests' | 'loans') => void;
}) {
  const stats = useMemo(() => {
    const activeLoans = loans.filter(l => !['RETURNED', 'LOST_SETTLED'].includes(l.status));
    const pendingDeposits = requests.filter(r => ['PENDING_APPROVAL', 'REJECTED_NO_COPY', 'EXPIRED_REFUND_DUE'].includes(r.status) && r.refundStatus !== 'REFUNDED');
    const lockedRequestWei = pendingDeposits.reduce((s, r) => s + BigInt(r.depositWei ?? '0'), BigInt(0));
    const lockedLoanWei = activeLoans
      .filter(l => l.status !== 'LOST_SHORTFALL_DUE')
      .reduce((s, l) => {
        const dep = books.find(b => b.bookId === l.bookId)?.depositWei ?? '50000000000000000000';
        return s + BigInt(dep);
      }, BigInt(0));
    const totalLockedWei = lockedRequestWei + lockedLoanWei;
    const refundedWei = loans.reduce((s, l) => s + BigInt(l.settlement?.refundWei ?? '0'), BigInt(0));
    const settledCount = loans.filter(l => ['RETURNED', 'LOST_SETTLED'].includes(l.status)).length;
    const availableCopies = books.reduce((s, b) => s + b.copiesAvailable, 0);
    const totalCopies = books.reduce((s, b) => s + b.copiesTotal, 0);
    const shortfallCount = activeLoans.filter(l => l.status === 'LOST_SHORTFALL_DUE').length;
    return {
      activeCount: activeLoans.length,
      pendingCount: pendingDeposits.length,
      totalLockedWei,
      refundedWei,
      settledCount,
      availableCopies,
      totalCopies,
      shortfallCount,
    };
  }, [books, requests, loans]);

  return (
    <div className="staff-kpi-strip" role="region" aria-label="Tổng quan thư viện sinh viên">
      <button type="button" className="staff-kpi-card" onClick={() => onSelectTab('loans')}>
        <span className="kpi-label">Sách đang mượn</span>
        <strong className="kpi-value tabular-value">{stats.activeCount} cuốn</strong>
        <span className={`kpi-sub ${stats.shortfallCount > 0 ? 'kpi-sub-warn' : ''}`}>
          {stats.shortfallCount > 0 ? `${stats.shortfallCount} khoản cần thanh toán phần thiếu` : `${stats.pendingCount} yêu cầu đang chờ duyệt`}
        </span>
      </button>
      <button type="button" className="staff-kpi-card" onClick={() => onSelectTab('requests')}>
        <span className="kpi-label">Cọc đang giữ trên Escrow</span>
        <strong className="kpi-value tabular-value">
          {formatWalletBalanceCompact(stats.totalLockedWei, 2).display}
        </strong>
        <span className="kpi-sub">Hoàn trả về ví sau khi trả sách & quyết toán</span>
      </button>
      <button type="button" className="staff-kpi-card" onClick={() => onSelectTab('loans')}>
        <span className="kpi-label">Cọc đã hoàn về ví ({stats.settledCount})</span>
        <strong className="kpi-value kpi-emerald tabular-value">
          {formatWalletBalanceCompact(stats.refundedWei, 2).display}
        </strong>
        <span className="kpi-sub">Đã tất toán trong sổ cái lịch sử</span>
      </button>
      <button type="button" className="staff-kpi-card" onClick={() => onSelectTab('catalog')}>
        <span className="kpi-label">Giáo trình sẵn sàng</span>
        <strong className="kpi-value tabular-value">
          {stats.availableCopies}/{stats.totalCopies} bản
        </strong>
        <span className="kpi-sub">{books.length} đầu sách trong danh mục</span>
      </button>
    </div>
  );
}

export default function LibrarySession() { return <WalletSession><LibraryWallet /></WalletSession>; }
function LibraryWallet() {
  const { state: wallet } = useCampusWallet();
  const [mode, setMode] = useState<'live' | 'demo'>('live');
  return <div className="library-shell">
    <PageHeading eyebrow="KHÔNG GIAN HỌC TẬP" title="Thư viện" description="Tìm sách, theo dõi lượt mượn và quản lý cọc CAMPUS." icon="book">
      <div className="mode-switch-wrapper">
        <span className="mode-switch-kicker">
          <span className={`mode-status-dot ${mode === 'live' ? 'dot-live' : 'dot-demo'}`} aria-hidden="true" />
          {mode === 'live' ? `Avalanche L1 · Chain ${CAMPUS_CHAIN_ID}` : 'Bản minh họa'}
        </span>
        <div className="student-mode-switch" role="group" aria-label="Chế độ thư viện sinh viên">
          <button type="button" className="secondary-btn" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>Thư viện thật</button>
          <button type="button" className="secondary-btn" aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}>Xem bản minh họa</button>
        </div>
      </div>
      <Link href="/student" className="secondary-btn heading-mobile-hide">Về ví sinh viên</Link>
    </PageHeading>
    {mode === 'live' ? <>
      <LibraryWalletSummary />
      <LibraryWorkspace key={`${wallet.address}:${wallet.chainId}`} onOpenDemo={() => setMode('demo')} />
    </> : <LibraryDemoWorkspace onBackToLive={() => setMode('live')} />}
  </div>;
}
function LibraryWorkspace({ onOpenDemo }: { onOpenDemo: () => void }) {
  const { state: wallet, controller } = useCampusWallet();
  const api = useMemo(() => new LibraryApi(), []);
  const [authenticated, setAuthenticated] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [books, setBooks] = useState<LibraryBook[]>([]), [requests, setRequests] = useState<LibraryRequest[]>([]), [loans, setLoans] = useState<LibraryLoan[]>([]);
  const [status, setStatus] = useState<LibraryAccountStatus | null>(null), [call, setCall] = useState<LibraryCall | null>(null);
  const [view, setView] = useState<'all' | 'catalog' | 'requests' | 'loans' | 'policy'>('all');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const query = useRef(''), active = useRef(true), operation = useRef(false);
  const reviewRef = useRef<HTMLElement>(null);
  const deployment = useMemo(() => { try { return getLibraryDeployment(); } catch { return null; } }, []);
  const [runtimeTreasury, setRuntimeTreasury] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const abort = new AbortController();
    void fetchRuntimeWalletConfig(fetch, abort.signal).then((cfg) => {
      if (!mounted) return;
      if (cfg?.libraryTreasury) setRuntimeTreasury(cfg.libraryTreasury);
    });
    return () => { mounted = false; abort.abort(); };
  }, []);
  const transactions = useMemo(() => {
    if (!deployment || deployment.status !== 'deployed' || !wallet.address) return null;
    return new LibraryTransactions({ deployment, account: wallet.address, treasuryOverride: runtimeTreasury, api, wallet: controller, storage: {
      getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value), removeItem: key => window.localStorage.removeItem(key),
    },
      lock: async (key, run) => { if (!navigator.locks) throw new LibraryUiError('LOCK_UNAVAILABLE'); await navigator.locks.request(key, run); } });
  }, [deployment, wallet.address, runtimeTreasury, api, controller]);
  async function refresh() {
    if (!wallet.address) return;
    await api.session(wallet.address);
    if (!active.current) return;
    setAuthenticated(true); setLoading(true); setCall(null);
    const results = await Promise.allSettled([api.books(query.current), api.requests(), api.loans(), api.accountStatus()]);
    if (!active.current) return;
    if (results[0].status === 'fulfilled') setBooks(results[0].value);
    if (results[1].status === 'fulfilled') setRequests(results[1].value);
    if (results[2].status === 'fulfilled') setLoans(results[2].value);
    setStatus(results[3].status === 'fulfilled' ? results[3].value : null);
    setRefreshVersion(version => version + 1);
    setLoading(false);
    const failure = results.find(r => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  async function run(work: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null); setNotice('');
    try { await work(); } catch (e) { if (active.current) {
      setError(libraryError(e));
      if (['UNAUTHENTICATED', 'WALLET_SESSION_CHANGED'].includes((e as {code?: string}).code ?? '')) {
        setAuthenticated(false); setCall(null); setStatus(null); setBooks([]); setRequests([]); setLoans([]);
      }
    } }
    finally { operation.current = false; if (active.current) { setBusy(false); setLoading(false); } }
  }
  useEffect(() => {
    active.current = true;
    if (wallet.address) void run(refresh);
    const focus = () => { if (wallet.address) void run(refresh); };
    window.addEventListener('focus', focus);
    return () => { active.current = false; window.removeEventListener('focus', focus); };
    // WalletWorkspace is remounted for every account or chain change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (call) reviewRef.current?.focus(); }, [call]);
  const blocked = !authenticated || !wallet.canProceed || !status || status.held || !transactions;
  const prepare = (id: string, action: StudentAction) => void run(async () => {
    if (!transactions) throw new LibraryUiError('CONFIGURATION_ERROR');
    const next = await transactions.prepare(id, action); if (active.current) setCall(next);
  });
  return <>
    <section className="surface-panel library-section" aria-labelledby="library-session-title" aria-busy={busy}>
      <h2 id="library-session-title">Đăng nhập thư viện</h2>
      <p>Chữ ký đăng nhập xác nhận ví của bạn; không chuyển tiền và không tốn gas.</p>
      {!authenticated ? <div className="library-actions">
        <button className="primary-cta-btn" type="button" disabled={busy || !wallet.address || wallet.chainId !== BigInt(campusNetwork.chainId)} onClick={() => void run(async () => {
          await signInLibraryStudent(wallet.address!, (account, message) => controller.signMessage(account, message)); await refresh();
        })}>Ký đăng nhập thư viện</button>
        <button className="secondary-btn" type="button" onClick={onOpenDemo}>Xem thử 8 đầu sách & luồng mượn mẫu</button>
      </div> : <div className="library-actions"><span className="network-pill pill-ok">Đã đăng nhập bằng ví</span>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(refresh)}>Làm mới trạng thái</button>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(async () => { await api.request('/api/auth/logout', {}); setAuthenticated(false); setBooks([]); setRequests([]); setLoans([]); setCall(null); setStatus(null); })}>Đăng xuất thư viện</button></div>}
      {deployment?.status === 'deployed' ? <p className="metric-note">{deployment.environment === 'local-anvil' ? 'Demo EVM local' : 'Avalanche L1'} · Escrow <HashChip value={deployment.escrow.address} copyLabel="Sao chép địa chỉ escrow thư viện" /></p>
        : <p className="wallet-warning">Chưa có manifest thư viện đã xác minh. Cần cấu hình escrow trước khi ký cọc.</p>}
      {busy ? (
        <div className="l1-status-shimmer" role="status">
          <span>Đang xử lý và đối chiếu dữ liệu trên mạng L1…</span>
          <div className="l1-shimmer-track" aria-hidden="true"><div className="l1-shimmer-bar" /></div>
        </div>
      ) : null}
      {error ? <p className="error-panel" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
    {authenticated ? <>
      <StudentLibrarySummaryStrip books={books} requests={requests} loans={loans} onSelectTab={tab => setView(tab)} />
      <div className="library-filter-bar" role="group" aria-label="Bộ lọc khu vực thư viện">
        {([
          ['all', 'Tất cả'],
          ['catalog', `Danh mục (${books.length})`],
          ['requests', `Yêu cầu (${requests.length})`],
          ['loans', `Khoản mượn (${loans.length})`],
          ['policy', 'Quy chế'],
        ] as const).map(([key, label]) => (
          <button key={key} type="button" className={`seg-btn ${view === key ? 'active' : ''}`} aria-pressed={view === key} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
      </div>
      {status?.held ? <aside className="surface-panel error-panel" aria-label="Khoản mượn cần xử lý"><h2>Tài khoản đang bị giữ</h2>
        <p>Mượn mới và thanh toán thường đang bị chặn. Bạn vẫn có thể trả sách, hoàn cọc và thanh toán phần thiếu.</p>
        <ul>{status.blockingLoanIds.map(id => <li key={id}><a href={`#loan-${id}`} onClick={() => setView('all')}>Xử lý khoản mượn <code>{id}</code></a></li>)}</ul></aside> : null}
      {call ? <section ref={reviewRef} tabIndex={-1} className="surface-panel library-review" aria-labelledby="review-title">
        <h2 id="review-title">{libraryLabels[call.action]} · kiểm tra trước khi ký</h2>
        <dl className="library-details"><dt>Ví ký</dt><dd><HashChip value={wallet.address ?? ''} copyLabel="Sao chép ví ký" /></dd><dt>Mạng</dt><dd>IntraCampus · {campusNetwork.chainId}</dd>
          <dt>Hợp đồng escrow</dt><dd><HashChip value={call.transaction.to} copyLabel="Sao chép hợp đồng escrow" /></dd><dt>Số tiền gửi</dt><dd>{formatWalletBalance(BigInt(call.amountWei))} + gas</dd>
          <dt>Đích nhận tiền</dt><dd><HashChip value={call.recipient} copyLabel="Sao chép đích nhận tiền" /></dd><dt>Mã yêu cầu</dt><dd><HashChip value={call.requestId} copyLabel="Sao chép mã yêu cầu" /></dd></dl>
        {call.action === 'refund' ? <p>Tiền cọc hoàn về ví: <strong>{formatWalletBalance(BigInt(call.refundWei))}</strong>.</p> : null}
        {call.action === 'deposit' ? <p>Cọc 50 CAMPUS. Thủ thư duyệt trong 24 giờ sau cọc; thời hạn mượn 14 ngày từ lúc duyệt. Nộp cọc chưa mở khoản mượn.</p> : null}
        {call.action === 'refund' ? <p>Không gửi thêm CAMPUS ngoài gas. Cọc hoàn về đúng ví đã mượn; chờ receipt được xác minh.</p> : null}
        <div className="library-actions"><button className="primary-cta-btn" type="button" disabled={busy || !wallet.canProceed} onClick={() => void run(async () => {
          try { await transactions!.send(call); setNotice('Đã gửi/đối chiếu giao dịch. Trạng thái chỉ xác nhận sau receipt hợp lệ.'); }
          finally { setCall(null); await refresh(); }
        })}>Xác nhận và mở ví</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => setCall(null)}>Hủy</button></div>
      </section> : null}
      {view === 'all' || view === 'catalog' ? <LibraryCatalog books={books} loading={loading} blocked={blocked} busy={busy} onSearch={q => { query.current = q; void run(refresh); }} onCreate={book => void run(async () => {
        if (blocked || !transactions) throw new LibraryUiError('ACTION_UNAVAILABLE');
        const key = `intracampus.library.create:${transactions.deploymentKey}:${wallet.address}:${book.bookId}`;
        if (!navigator.locks) throw new LibraryUiError('LOCK_UNAVAILABLE');
        await navigator.locks.request(key, async () => {
          let id = window.localStorage.getItem(key);
          if (!id) { id = crypto.randomUUID(); window.localStorage.setItem(key, id); check(window.localStorage.getItem(key) === id); }
          await api.session(wallet.address!);
          const request = await api.create(book.bookId, id);
          window.localStorage.removeItem(key);
          if (active.current) setRequests(previous => [request, ...previous.filter(r => r.requestId !== request.requestId)]);
          const next = await transactions.prepare(request.requestId, 'deposit'); if (active.current) setCall(next);
        });
      })} /> : null}
      {view === 'all' || view === 'requests' ? <>
        <LibraryRequests requests={requests} books={books} transactions={transactions} chainTime={status?.checkedAt ?? null}
          onReplace={request => void run(async () => {
            if (blocked || !request.depositConflict) throw new LibraryUiError('ACTION_UNAVAILABLE');
            await api.session(wallet.address!);
            await api.create(request.bookId, `replacement-${request.requestId}`);
            await refresh();
            setNotice('Đã tạo hoặc mở lại yêu cầu thay thế. Xem mã trong danh sách yêu cầu. Chưa gửi cọc.');
          })}
          walletReady={wallet.canProceed} busy={busy} blocked={blocked} onPrepare={prepare} onRecover={(id, action, hash) => void run(async () => {
          if (!transactions) throw new LibraryUiError('CONFIGURATION_ERROR');
          await transactions.reconcile(id, action, hash); await refresh(); setNotice('Đã đối chiếu. Nếu vẫn chưa rõ kết quả, tiếp tục giữ hash và chưa gửi lại.');
        })} />
        <UnmatchedDeposits api={api} refreshVersion={refreshVersion} />
      </> : null}
      {view === 'all' || view === 'loans' ? <LibraryLoans loans={loans} books={books} busy={busy} onShortfall={loan => prepare(loan.requestId, 'payShortfall')}
        onReturn={loan => void run(async () => { await api.session(wallet.address!); await api.returnBook(loan.loanId); await refresh(); setNotice('Đã gửi yêu cầu trả. Đưa sách cho thủ thư kiểm tra.'); })} /> : null}
    </> : null}
    {!authenticated || view === 'all' || view === 'policy' ? <LibraryPolicyCard defaultOpen={view === 'policy'} /> : null}
  </>;
}

function LibraryPolicyCard({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return <section className="surface-panel library-section library-policy" aria-labelledby="library-policy-title">
    <div className="staff-record-head">
      <div><span className="eyebrow">QUY ĐỊNH ESCROW</span><h2 id="library-policy-title">Quy chế mượn & tiền cọc</h2></div>
    </div>
    <dl className="library-policy-strip">
      <div className="policy-stat-chip"><dt>Tiền cọc</dt><dd><strong>50 CAMPUS</strong> / bản</dd></div>
      <div className="policy-stat-chip"><dt>Thời hạn mượn</dt><dd><strong>14 ngày</strong> (duyệt 24h)</dd></div>
      <div className="policy-stat-chip"><dt>Ân hạn miễn phí</dt><dd><strong>3 ngày</strong> sau hạn trả</dd></div>
      <div className="policy-stat-chip"><dt>Phí trả trễ</dt><dd><strong>0,1 CAMPUS</strong> / 24h</dd></div>
    </dl>
    <details className="library-policy-full" open={defaultOpen || undefined}>
      <summary>Xem chi tiết hoàn cọc, hư hỏng và các trường hợp đặc biệt</summary>
      <p>Tiền cọc và trạng thái cuối được xác minh trực tiếp từ hợp đồng escrow trên IntraCampus L1. Tổng phí trễ tối đa 25 CAMPUS.</p>
      <dl className="library-policy-cases">
        <div><dt>Trả đúng hạn hoặc trong ân hạn</dt><dd>Sách nguyên vẹn được hoàn đủ 50 CAMPUS sau khi thủ thư nhận sách và giao dịch quyết toán được xác minh.</dd></div>
        <div><dt>Trả trễ đến đúng 30 ngày</dt><dd>Hoàn cọc sau khi trừ phí trễ và sửa chữa nếu có, tổng khấu trừ tối đa tiền cọc. Sách nguyên vẹn trả đúng 30 ngày sau hạn tính 27 kỳ phí, giữ 2,7 CAMPUS và hoàn 47,3 CAMPUS.</dd></div>
        <div><dt>Trả quá 30 ngày</dt><dd>Giữ toàn bộ cọc 50 CAMPUS khi quyết toán. Sinh viên vẫn có thể yêu cầu trả sách và xử lý phần thiếu để gỡ hạn chế tài khoản.</dd></div>
        <div><dt>Sách hỏng</dt><dd>Phí sửa chữa thực thu cộng phí trễ không vượt tiền cọc. Sách cần bảo trì được ghi nhận riêng.</dd></div>
        <div><dt>Mất sách</dt><dd>Tính theo giá thay thế của sách, hoàn cọc dư hoặc thanh toán phần thiếu. Không cộng phí trễ riêng.</dd></div>
        <div><dt>Hết bản sau khi cọc hoặc hết giờ duyệt</dt><dd>Chưa tạo khoản mượn. Chờ thủ thư hoàn hoặc nhận lại cọc khi đủ 24 giờ từ lúc cọc xác nhận. Chỉ ghi nhận đã hoàn sau khi giao dịch được xác minh.</dd></div>
      </dl>
    </details>
  </section>;
}

function LibraryDemoWorkspace({ onBackToLive }: { onBackToLive: () => void }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [view, setView] = useState<'all' | 'catalog' | 'requests' | 'loans' | 'policy'>('all');
  const [requests, setRequests] = useState<LibraryRequest[]>(demoLibraryRequests);
  const [loans, setLoans] = useState<LibraryLoan[]>(demoStudentLibraryLoans);
  const [demoNotice, setDemoNotice] = useState('');
  const [pendingAction, setPendingAction] = useState<{
    action: 'deposit' | 'refund' | 'payShortfall';
    requestId: string;
    book: LibraryBook;
    amountWei: string;
    refundWei?: string;
  } | null>(null);
  const reviewRef = useRef<HTMLElement>(null);

  const filteredBooks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return demoLibraryBooks;
    return demoLibraryBooks.filter(
      b =>
        b.title.toLowerCase().includes(q) ||
        b.author.toLowerCase().includes(q) ||
        (b.isbn ?? '').toLowerCase().includes(q),
    );
  }, [searchQuery]);

  return <>
    <section className="demo-control-strip demo-pill-bar" aria-label="Điều khiển bản minh họa thư viện">
      <div className="demo-pill-left">
        <span className="demo-pill-badge">
          <span className="mode-status-dot dot-demo" aria-hidden="true" />
          Bản minh họa · 8 giáo trình mẫu
        </span>
        <span className="demo-pill-summary">Trải nghiệm bìa sách, đặt cọc Escrow và sổ cái nhận cọc thu gọn</span>
      </div>
      <div className="demo-pill-actions">
        <button type="button" className="secondary-btn btn-pill-sm" onClick={() => { setRequests(demoLibraryRequests); setLoans(demoStudentLibraryLoans); setPendingAction(null); setDemoNotice('Đã khôi phục bộ dữ liệu thư viện mẫu ban đầu.'); }}>Khôi phục mặc định</button>
        <button type="button" className="secondary-btn btn-pill-sm" onClick={onBackToLive}>Thư viện thật →</button>
      </div>
    </section>

    {demoNotice ? <p className="surface-panel" role="status">{demoNotice}</p> : null}

    <StudentLibrarySummaryStrip books={demoLibraryBooks} requests={requests} loans={loans} onSelectTab={tab => setView(tab)} />

    <div className="library-filter-bar" role="group" aria-label="Bộ lọc khu vực thư viện mẫu">
      {([
        ['all', 'Tất cả'],
        ['catalog', `Danh mục (${filteredBooks.length})`],
        ['requests', `Yêu cầu (${requests.length})`],
        ['loans', `Khoản mượn (${loans.length})`],
        ['policy', 'Quy chế'],
      ] as const).map(([key, label]) => (
        <button key={key} type="button" className={`seg-btn ${view === key ? 'active' : ''}`} aria-pressed={view === key} onClick={() => setView(key)}>
          {label}
        </button>
      ))}
    </div>

    {pendingAction ? (
      <section ref={reviewRef} tabIndex={-1} className="surface-panel library-review" aria-labelledby="demo-review-title">
        <span className="fixture-pill">Mô phỏng giao dịch · Dữ liệu mẫu</span>
        <h2 id="demo-review-title">{libraryLabels[pendingAction.action]} · kiểm tra trước khi ký</h2>
        <p>Sách: <strong>{pendingAction.book.title}</strong> ({pendingAction.book.author})</p>
        <dl className="library-details">
          <dt>Ví ký mẫu</dt><dd><HashChip value="0x83907f9a2685efcbb2beda057cb23a3809c8f750" copyLabel="Sao chép ví mẫu" /></dd>
          <dt>Mạng</dt><dd>IntraCampus · {campusNetwork.chainId}</dd>
          <dt>Hợp đồng escrow</dt><dd><HashChip value="0x43683f8107e3d3a883924989941620c5c260a124" copyLabel="Sao chép escrow mẫu" /></dd>
          <dt>Số tiền gửi</dt><dd>{formatWalletBalance(BigInt(pendingAction.amountWei))} + gas</dd>
          <dt>Mã yêu cầu</dt><dd><HashChip value={pendingAction.requestId} copyLabel="Sao chép mã yêu cầu mẫu" /></dd>
        </dl>
        {pendingAction.action === 'deposit' ? <p>Cọc 50 CAMPUS. Thủ thư duyệt trong 24 giờ sau cọc; thời hạn mượn 14 ngày từ lúc duyệt.</p> : null}
        {pendingAction.action === 'refund' && pendingAction.refundWei ? <p>Tiền cọc hoàn về ví mẫu: <strong>{formatWalletBalance(BigInt(pendingAction.refundWei))}</strong>.</p> : null}
        <div className="library-actions">
          <button
            type="button"
            className="primary-cta-btn"
            onClick={() => {
              if (pendingAction.action === 'deposit') {
                const nowSec = Math.floor(Date.now() / 1000);
                const newReq: LibraryRequest = {
                  requestId: pendingAction.requestId as `0x${string}`,
                  bookId: pendingAction.book.bookId,
                  status: 'PENDING_APPROVAL',
                  refundStatus: 'NONE',
                  depositWei: pendingAction.amountWei,
                  depositIntent: null,
                  approvalDeadline: nowSec + 86400,
                  loanId: null,
                  transactions: [
                    {
                      action: 'deposit',
                      txHash: '0x77a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e99',
                      status: 'CONFIRMED',
                      submittedAt: nowSec,
                      proof: {
                        chainId: CAMPUS_CHAIN_ID,
                        contractAddress: '0x43683f8107e3d3a883924989941620c5c260a124',
                        txHash: '0x77a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e99',
                        blockNumber: 39,
                        blockHash: '0x66a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e88',
                        logIndex: 0,
                        eventName: 'DepositReceived',
                        requestId: pendingAction.requestId as `0x${string}`,
                        borrower: '0x83907f9a2685efcbb2beda057cb23a3809c8f750',
                      },
                    },
                  ],
                  createdAt: nowSec,
                  updatedAt: nowSec,
                };
                setRequests(prev => [newReq, ...prev]);
                setDemoNotice(`Đã mô phỏng nộp cọc 50 CAMPUS cho sách "${pendingAction.book.title}". Yêu cầu đã chuyển sang trạng thái Chờ thủ thư duyệt.`);
              } else if (pendingAction.action === 'refund') {
                setRequests(prev =>
                  prev.map(r =>
                    r.requestId === pendingAction.requestId
                      ? { ...r, refundStatus: 'REFUNDED' }
                      : r,
                  ),
                );
                setDemoNotice('Đã mô phỏng nhận lại 50 CAMPUS tiền cọc hết hạn về ví sinh viên.');
              } else if (pendingAction.action === 'payShortfall') {
                setLoans(prev =>
                  prev.map(l =>
                    l.requestId === pendingAction.requestId
                      ? { ...l, status: 'LOST_SETTLED' }
                      : l,
                  ),
                );
                setDemoNotice('Đã mô phỏng thanh toán 30 CAMPUS phần thiếu sách mất. Khoản mượn đã tất toán.');
              }
              setPendingAction(null);
            }}
          >
            Mô phỏng ký & xác nhận (Bản minh họa)
          </button>
          <button type="button" className="secondary-btn" onClick={() => setPendingAction(null)}>Hủy</button>
        </div>
      </section>
    ) : null}

    {view === 'all' || view === 'catalog' ? (
      <LibraryCatalog
        books={filteredBooks}
        loading={false}
        blocked={false}
        busy={false}
        onSearch={q => setSearchQuery(q)}
        onCreate={book => {
          const fakeReqId = `0x${Array.from({ length: 64 }, (_, i) => ((i + book.title.length) % 16).toString(16)).join('')}`;
          setPendingAction({
            action: 'deposit',
            requestId: fakeReqId,
            book,
            amountWei: book.depositWei,
          });
          setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
        }}
      />
    ) : null}

    {view === 'all' || view === 'requests' ? (
      <LibraryRequests
        requests={requests}
        books={demoLibraryBooks}
        transactions={null}
        chainTime={1794972000}
        onReplace={() => {}}
        walletReady={true}
        busy={false}
        blocked={false}
        onPrepare={(id, action) => {
          const req = requests.find(r => r.requestId === id);
          const book = demoLibraryBooks.find(b => b.bookId === req?.bookId) ?? demoLibraryBooks[0];
          setPendingAction({
            action: action === 'refund' ? 'refund' : 'deposit',
            requestId: id,
            book,
            amountWei: action === 'refund' ? '0' : book.depositWei,
            refundWei: req?.depositWei ?? book.depositWei,
          });
          setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
        }}
        onRecover={() => {}}
      />
    ) : null}

    {view === 'all' || view === 'loans' ? (
      <LibraryLoans
        loans={loans}
        books={demoLibraryBooks}
        busy={false}
        onShortfall={loan => {
          const book = demoLibraryBooks.find(b => b.bookId === loan.bookId) ?? demoLibraryBooks[1];
          const shortfallWei = loan.settlement?.outcome === 'LOST' ? loan.settlement.shortfallWei : '30000000000000000000';
          setPendingAction({
            action: 'payShortfall',
            requestId: loan.requestId,
            book,
            amountWei: shortfallWei,
          });
          setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
        }}
        onReturn={loan => {
          const nowSec = Math.floor(Date.now() / 1000);
          setLoans(prev =>
            prev.map(l =>
              l.loanId === loan.loanId
                ? { ...l, status: 'RETURN_REQUESTED', returnRequestedAt: nowSec }
                : l,
            ),
          );
          setDemoNotice('Đã mô phỏng gửi yêu cầu trả sách. Trong quy trình thật, bạn mang sách tới quầy để thủ thư xác nhận.');
        }}
      />
    ) : null}

    {view === 'all' || view === 'policy' ? <LibraryPolicyCard defaultOpen={view === 'policy'} /> : null}
  </>;
}
