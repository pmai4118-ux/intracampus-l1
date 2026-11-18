'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { campusNetwork, getLibraryDeployment, type LibraryBook, type LibraryRequest, type LibraryLoan, type LibraryAccountStatus } from '@intracampus/network';
import { WalletSession, useCampusWallet } from '../WalletPanel';
import { formatWalletBalance } from '../../../lib/chains';
import { LibraryApi, LibraryUiError, check } from '../../../lib/library-api';
import { signInLibraryStudent } from '../../../lib/library-session';
import { LibraryTransactions, type LibraryCall, type StudentAction } from '../../../lib/library-transactions';
import { libraryError, libraryLabels } from '../../../lib/library';
import LibraryCatalog from './LibraryCatalog';
import LibraryLoans from './LibraryLoans';
import LibraryRequests from './LibraryRequests';
import UnmatchedDeposits from './UnmatchedDeposits';
import LibraryWalletSummary from './LibraryWalletSummary';
import PageHeading from '../../components/PageHeading';

export default function LibrarySession() { return <WalletSession><LibraryWallet /></WalletSession>; }
function LibraryWallet() {
  const { state: wallet } = useCampusWallet();
  return <div className="library-shell">
    <PageHeading eyebrow="KHÔNG GIAN HỌC TẬP" title="Thư viện" description="Tìm sách, theo dõi lượt mượn và quản lý cọc CAMPUS." icon="book"><Link href="/student" className="secondary-btn">Về ví sinh viên</Link></PageHeading>
    <LibraryWalletSummary />
    <LibraryWorkspace key={`${wallet.address}:${wallet.chainId}`} />
  </div>;
}
function LibraryWorkspace() {
  const { state: wallet, controller } = useCampusWallet();
  const api = useMemo(() => new LibraryApi(), []);
  const [authenticated, setAuthenticated] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [books, setBooks] = useState<LibraryBook[]>([]), [requests, setRequests] = useState<LibraryRequest[]>([]), [loans, setLoans] = useState<LibraryLoan[]>([]);
  const [status, setStatus] = useState<LibraryAccountStatus | null>(null), [call, setCall] = useState<LibraryCall | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const query = useRef(''), active = useRef(true), operation = useRef(false);
  const reviewRef = useRef<HTMLElement>(null);
  const deployment = useMemo(() => { try { return getLibraryDeployment(); } catch { return null; } }, []);
  const transactions = useMemo(() => {
    if (!deployment || deployment.status !== 'deployed' || !wallet.address) return null;
    return new LibraryTransactions({ deployment, account: wallet.address, api, wallet: controller, storage: {
      getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value), removeItem: key => window.localStorage.removeItem(key),
    },
      lock: async (key, run) => { if (!navigator.locks) throw new LibraryUiError('LOCK_UNAVAILABLE'); await navigator.locks.request(key, run); } });
  }, [deployment, wallet.address, api, controller]);
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
      {!authenticated ? <button className="primary-cta-btn" type="button" disabled={busy || !wallet.address || wallet.chainId !== BigInt(campusNetwork.chainId)} onClick={() => void run(async () => {
        await signInLibraryStudent(wallet.address!, (account, message) => controller.signMessage(account, message)); await refresh();
      })}>Ký đăng nhập thư viện</button> : <div className="library-actions"><span className="network-pill">Đã đăng nhập bằng ví</span>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(refresh)}>Làm mới trạng thái</button>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => void run(async () => { await api.request('/api/auth/logout', {}); setAuthenticated(false); setBooks([]); setRequests([]); setLoans([]); setCall(null); setStatus(null); })}>Đăng xuất thư viện</button></div>}
      {deployment?.status === 'deployed' ? <p className="metric-note">{deployment.environment === 'local-anvil' ? 'Demo EVM local' : 'Avalanche L1'} · Escrow <code>{deployment.escrow.address}</code></p>
        : <p className="wallet-warning">Chưa có manifest thư viện đã xác minh. Cần cấu hình escrow trước khi ký cọc.</p>}
      {busy ? <p role="status">Đang xử lý…</p> : null}
      {error ? <p className="error-panel" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
    {authenticated ? <>
      {status?.held ? <aside className="surface-panel error-panel" aria-label="Khoản mượn cần xử lý"><h2>Tài khoản đang bị giữ</h2>
        <p>Mượn mới và thanh toán thường đang bị chặn. Bạn vẫn có thể trả sách, hoàn cọc và thanh toán phần thiếu.</p>
        <ul>{status.blockingLoanIds.map(id => <li key={id}><a href={`#loan-${id}`}>Xử lý khoản mượn <code>{id}</code></a></li>)}</ul></aside> : null}
      <LibraryCatalog books={books} loading={loading} blocked={blocked} busy={busy} onSearch={q => { query.current = q; void run(refresh); }} onCreate={book => void run(async () => {
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
      })} />
      {call ? <section ref={reviewRef} tabIndex={-1} className="surface-panel library-review" aria-labelledby="review-title">
        <h2 id="review-title">{libraryLabels[call.action]} · kiểm tra trước khi ký</h2>
        <dl className="library-details"><dt>Ví ký</dt><dd><code>{wallet.address}</code></dd><dt>Mạng</dt><dd>IntraCampus · {campusNetwork.chainId}</dd>
          <dt>Hợp đồng escrow</dt><dd><code>{call.transaction.to}</code></dd><dt>Số tiền gửi</dt><dd>{formatWalletBalance(BigInt(call.amountWei))} + gas</dd>
          <dt>Đích nhận tiền</dt><dd><code>{call.recipient}</code></dd><dt>Mã yêu cầu</dt><dd><code>{call.requestId}</code></dd></dl>
        {call.action === 'refund' ? <p>Tiền cọc hoàn về ví: <strong>{formatWalletBalance(BigInt(call.refundWei))}</strong>.</p> : null}
        {call.action === 'deposit' ? <p>Cọc 50 CAMPUS. Thủ thư duyệt trong 24 giờ sau cọc; thời hạn mượn 14 ngày từ lúc duyệt. Nộp cọc chưa mở khoản mượn.</p> : null}
        {call.action === 'refund' ? <p>Không gửi thêm CAMPUS ngoài gas. Cọc hoàn về đúng ví đã mượn; chờ receipt được xác minh.</p> : null}
        <div className="library-actions"><button className="primary-cta-btn" type="button" disabled={busy || !wallet.canProceed} onClick={() => void run(async () => {
          try { await transactions!.send(call); setNotice('Đã gửi/đối chiếu giao dịch. Trạng thái chỉ xác nhận sau receipt hợp lệ.'); }
          finally { setCall(null); await refresh(); }
        })}>Xác nhận và mở ví</button><button type="button" className="secondary-btn" disabled={busy} onClick={() => setCall(null)}>Hủy</button></div>
      </section> : null}
      <LibraryRequests requests={requests} books={books} transactions={transactions} chainTime={status?.checkedAt ?? null}
        onReplace={request => void run(async () => {
          if (blocked || !request.depositConflict) throw new LibraryUiError('ACTION_UNAVAILABLE');
          await api.session(wallet.address!);
          const replacement = await api.create(request.bookId, `replacement-${request.requestId}`);
          await refresh();
          setNotice('Đã tạo hoặc mở lại yêu cầu thay thế. Xem mã trong danh sách yêu cầu. Chưa gửi cọc.');
        })}
        walletReady={wallet.canProceed} busy={busy} blocked={blocked} onPrepare={prepare} onRecover={(id, action, hash) => void run(async () => {
        if (!transactions) throw new LibraryUiError('CONFIGURATION_ERROR');
        await transactions.reconcile(id, action, hash); await refresh(); setNotice('Đã đối chiếu. Nếu vẫn chưa rõ kết quả, tiếp tục giữ hash và chưa gửi lại.');
      })} />
      <UnmatchedDeposits api={api} refreshVersion={refreshVersion} />
      <LibraryLoans loans={loans} books={books} busy={busy} onShortfall={loan => prepare(loan.requestId, 'payShortfall')}
        onReturn={loan => void run(async () => { await api.session(wallet.address!); await api.returnBook(loan.loanId); await refresh(); setNotice('Đã gửi yêu cầu trả. Đưa sách cho thủ thư kiểm tra.'); })} />
    </> : null}
    <section className="surface-panel library-section library-policy" aria-labelledby="library-policy-title"><h2 id="library-policy-title">Quy chế mượn & tiền cọc</h2>
      <dl className="library-policy-facts">
        <div><dt>Tiền cọc</dt><dd><strong>50 CAMPUS</strong> mỗi bản. Giá thay thế hiển thị riêng theo sách.</dd></div>
        <div><dt>Chờ duyệt</dt><dd>Tối đa <strong>24 giờ</strong> từ lúc cọc xác nhận trên mạng. Đúng hạn này, thủ thư không thể duyệt thêm.</dd></div>
        <div><dt>Thời hạn mượn</dt><dd><strong>14 ngày</strong> kể từ lúc duyệt.</dd></div>
        <div><dt>Ân hạn</dt><dd><strong>3 ngày</strong> sau hạn trả, chưa tính phí trễ.</dd></div>
        <div><dt>Phí trả trễ</dt><dd><strong>0,1 CAMPUS</strong> mỗi kỳ đủ 24 giờ sau ân hạn. Tối đa <strong>25 CAMPUS</strong>.</dd></div>
      </dl>
      <details className="library-policy-full"><summary>Hoàn cọc và trường hợp đặc biệt</summary>
        <p>Quy chế đầy đủ về hoàn cọc và quyết toán. Tiền và trạng thái cuối được xác minh từ hợp đồng.</p>
        <dl className="library-policy-cases">
          <div><dt>Trả đúng hạn hoặc trong ân hạn</dt><dd>Sách nguyên vẹn được hoàn đủ 50 CAMPUS sau khi thủ thư nhận sách và giao dịch quyết toán được xác minh.</dd></div>
          <div><dt>Trả trễ đến đúng 30 ngày</dt><dd>Hoàn cọc sau khi trừ phí trễ và sửa chữa nếu có, tổng khấu trừ tối đa tiền cọc. Sách nguyên vẹn trả đúng 30 ngày sau hạn tính 27 kỳ phí, giữ 2,7 CAMPUS và hoàn 47,3 CAMPUS.</dd></div>
          <div><dt>Trả quá 30 ngày</dt><dd>Giữ toàn bộ cọc 50 CAMPUS khi quyết toán. Sinh viên vẫn có thể yêu cầu trả sách và xử lý phần thiếu để gỡ hạn chế tài khoản.</dd></div>
          <div><dt>Sách hỏng</dt><dd>Phí sửa chữa thực thu cộng phí trễ không vượt tiền cọc. Sách cần bảo trì được ghi nhận riêng.</dd></div>
          <div><dt>Mất sách</dt><dd>Tính theo giá thay thế của sách, hoàn cọc dư hoặc thanh toán phần thiếu. Không cộng phí trễ riêng.</dd></div>
          <div><dt>Hết bản sau khi cọc hoặc hết giờ duyệt</dt><dd>Chưa tạo khoản mượn. Chờ thủ thư hoàn hoặc nhận lại cọc khi đủ 24 giờ từ lúc cọc xác nhận. Chỉ ghi nhận đã hoàn sau khi giao dịch được xác minh.</dd></div>
        </dl>
      </details>
    </section>
  </>;
}
