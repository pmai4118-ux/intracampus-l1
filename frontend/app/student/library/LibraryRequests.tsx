import { useEffect, useState } from 'react';
import type { LibraryBook, LibraryRequest } from '@intracampus/network';
import { canClaimLibraryRefund, libraryDate, libraryLabels, libraryRecoveryDetails } from '../../../lib/library';
import { LibraryTransactions, type StudentAction } from '../../../lib/library-transactions';
import HashChip from '../../components/HashChip';
import PaginationBar from '../../components/PaginationBar';

const LOAN_STAGE_STATUSES = new Set([
  'APPROVED',
  'RETURN_REQUESTED',
  'SETTLEMENT_PENDING',
  'RETURNED',
  'LOST_SHORTFALL_DUE',
  'LOST_SETTLED',
]);

function hasActiveRecovery(request: LibraryRequest, transactions: LibraryTransactions | null): boolean {
  if (!transactions) return false;
  return (['deposit', 'refund', 'payShortfall'] as StudentAction[]).some(action => {
    try {
      const record = transactions.journal(request.requestId, action);
      return Boolean(record && record.phase !== 'confirmed');
    } catch {
      return true;
    }
  });
}

function refundLineLabel(request: LibraryRequest): string {
  if (['RETURNED', 'LOST_SETTLED', 'LOST_SHORTFALL_DUE'].includes(request.status)) {
    return 'Đã quyết toán tại mục 03 (Khoản mượn)';
  }
  if (LOAN_STAGE_STATUSES.has(request.status) || request.loanId !== null) {
    return 'Đã chuyển sang khoản mượn (Mục 03)';
  }
  return libraryLabels[request.refundStatus];
}

export default function LibraryRequests({ requests, books, transactions, busy, blocked, chainTime, walletReady, onPrepare, onRecover, onReplace }: {
  requests: LibraryRequest[]; books: LibraryBook[]; transactions: LibraryTransactions | null; busy: boolean; blocked: boolean;
  chainTime: number | null; walletReady: boolean;
  onPrepare(id: string, action: StudentAction): void; onRecover(id: string, action: StudentAction, hash?: string): void;
  onReplace(request: LibraryRequest): void;
}) {
  const [showLoanHistory, setShowLoanHistory] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(8);
  const primaryRequests = requests.filter(r => !LOAN_STAGE_STATUSES.has(r.status) || hasActiveRecovery(r, transactions));
  const archivedCount = requests.length - primaryRequests.length;
  const visibleRequests = showLoanHistory ? requests : primaryRequests;

  useEffect(() => {
    setPage(1);
  }, [showLoanHistory, visibleRequests.length]);

  const effectiveSize = pageSize <= 0 ? Math.max(1, visibleRequests.length) : pageSize;
  const safePage = Math.min(page, Math.max(1, Math.ceil(visibleRequests.length / effectiveSize)));
  const pagedRequests = visibleRequests.slice((safePage - 1) * effectiveSize, safePage * effectiveSize);

  return <section className="surface-panel library-section" aria-labelledby="requests-title">
    <div className="staff-record-head">
      <div>
        <span className="eyebrow">02 / Nộp cọc & chờ duyệt</span>
        <h2 id="requests-title">Yêu cầu của bạn ({visibleRequests.length})</h2>
      </div>
      {archivedCount > 0 ? (
        <button type="button" className="text-action-btn" onClick={() => setShowLoanHistory(prev => !prev)}>
          {showLoanHistory ? 'Ẩn yêu cầu đã sang mục 03' : `Xem cả yêu cầu đã duyệt (${archivedCount})`}
        </button>
      ) : null}
    </div>
    {requests.length === 0 ? <p>Chưa có yêu cầu mượn.</p> : visibleRequests.length === 0 ? (
      <p className="muted-line">Không có yêu cầu đang chờ duyệt. Các yêu cầu đã duyệt ({archivedCount}) được theo dõi trực tiếp tại <strong>03 / Khoản mượn & lịch sử nhận cọc</strong> bên dưới.</p>
    ) : null}
    <ul className="library-list">{pagedRequests.map(request => <li className="library-record staff-record" key={request.requestId}>
      <div className="staff-record-head">
        <div className="staff-record-main">
          <div className="staff-title-row">
            <h3>{books.find(book => book.bookId === request.bookId)?.title ?? 'Yêu cầu mượn sách'}</h3>
            <span className={`network-pill ${request.status === 'APPROVED' || request.refundStatus === 'REFUNDED' ? 'pill-ok' : ['REJECTED', 'REJECTED_NO_COPY', 'EXPIRED_REFUND_DUE'].includes(request.status) ? 'pill-danger' : 'pill-warning'}`}>{request.refundStatus === 'REFUNDED' && request.status === 'REJECTED_NO_COPY'
              ? 'Hết bản · đã hoàn cọc' : request.refundStatus === 'REFUNDED' && request.status === 'EXPIRED_REFUND_DUE'
                ? 'Hết hạn duyệt · đã hoàn cọc' : libraryLabels[request.status]}</span>
          </div>
          <div className="staff-meta-chips">
            <span>Mã yêu cầu: <HashChip value={request.requestId} copyLabel="Sao chép mã yêu cầu" /></span>
          </div>
        </div>
        <div className="library-actions staff-actions-right">
          {request.status === 'AWAITING_DEPOSIT' ? <button type="button" className="primary-cta-btn" disabled={busy || blocked || !transactions || !request.depositIntent}
            onClick={() => onPrepare(request.requestId, 'deposit')}>Xem cọc trước khi ký</button> : null}
          {canClaimLibraryRefund(request, chainTime) ? <button type="button" className="secondary-btn" disabled={busy || !transactions || !walletReady}
            onClick={() => onPrepare(request.requestId, 'refund')}>Xem hoàn cọc hết hạn</button> : null}
        </div>
      </div>
      <details><summary>Mã yêu cầu đầy đủ</summary><p><code>{request.requestId}</code></p></details>
      <dl className="loan-timeline-grid">
        <div><dt>Hạn duyệt</dt><dd className="tabular-value">{libraryDate(request.approvalDeadline)}</dd></div>
        <div><dt>Trạng thái tiền cọc</dt><dd>{refundLineLabel(request)}</dd></div>
      </dl>
      {request.status === 'PENDING_APPROVAL' ? <p>Cọc đã xác minh. Khoản mượn chưa hoạt động; đang chờ thủ thư duyệt trước hạn trên.</p> : null}
      {request.depositConflict && <aside className="wallet-warning"><p>Mã yêu cầu này đã có khoản cọc khác trên mạng, không khớp ví hoặc sách của bạn. Chưa tạo khoản mượn từ khoản cọc đó. Nếu bạn đã ký, giữ mã giao dịch và đối chiếu lượt cũ.</p>
        <details><summary>Xem khoản cọc cần xử lý riêng</summary><p>Ví đã nộp <code>{request.depositConflict.borrower}</code></p><p>Mã giao dịch <code>{request.depositConflict.depositProof.txHash}</code></p><p>Tiền hoàn luôn về ví đã nộp, không chuyển về ví đang xem yêu cầu.</p></details>
        <button type="button" className="secondary-btn" disabled={busy || blocked} onClick={() => onReplace(request)}>Tạo hoặc xem yêu cầu thay thế</button><p>Chỉ tạo yêu cầu mới, chưa gửi tiền hoặc mở ví ký.</p></aside>}
      {request.status === 'REJECTED_NO_COPY' && request.refundStatus === 'REFUND_DUE'
        ? <p>Không còn bản sau khi cọc. Thủ thư có thể từ chối để hoàn tiền; bạn có thể nhận lại cọc khi hết hạn duyệt.</p> : null}
      {(['deposit','refund','payShortfall'] as StudentAction[]).map(action => <Recovery key={action} request={request} action={action}
        transactions={transactions} busy={busy} onRecover={onRecover} />)}
      {request.transactions.filter(tx => !['deposit','refund','payShortfall'].includes(tx.action)).map(tx => <p key={`${tx.action}:${tx.txHash}`}>
        {libraryLabels[tx.action] ?? tx.action}: {libraryLabels[tx.status === 'CONFIRMED' && !transactions?.confirmedProof(request.requestId, tx) ? 'SUBMITTED' : tx.status]}
      </p>)}
      {request.transactions.some(tx => !['deposit','refund','payShortfall'].includes(tx.action)) && <details><summary>Chi tiết giao dịch thủ thư</summary>{request.transactions.filter(tx => !['deposit','refund','payShortfall'].includes(tx.action)).map(tx => <p key={tx.txHash}>{libraryLabels[tx.action]} <code>{tx.txHash}</code></p>)}</details>}
    </li>)}</ul>
    <PaginationBar
      total={visibleRequests.length}
      page={safePage}
      pageSize={pageSize}
      onPage={setPage}
      onPageSize={setPageSize}
      sizes={[8, 16, 0]}
      unitLabel="yêu cầu"
    />
  </section>;
}
function Recovery({ request, action, transactions, busy, onRecover }: {
  request: LibraryRequest; action: StudentAction; transactions: LibraryTransactions | null; busy: boolean;
  onRecover(id: string, action: StudentAction, hash?: string): void;
}) {
  const [hash, setHash] = useState('');
  let record;
  try { record = transactions?.journal(request.requestId, action); } catch { return <div role="alert"><p>Nhật ký không đọc được. Giữ mã yêu cầu và hash để đối chiếu; chưa ký thêm.</p>
    {transactions?.retainedHash(request.requestId, action) ? <code>{transactions.retainedHash(request.requestId, action)}</code> : null}</div>; }
  const tx = request.transactions.find(t => t.action === action && (!record?.hash || t.txHash.toLowerCase() === record.hash.toLowerCase()));
  if (!record && !tx) return null;
  const unknown = record?.phase === 'unknown' && !record.hash;
  const { hash: storedHash, matchedTx } = libraryRecoveryDetails(record, tx);
  const proof = transactions?.confirmedProof(request.requestId, matchedTx);
  const label = unknown ? 'Chưa rõ ví đã gửi hay chưa'
    : libraryLabels[matchedTx && (matchedTx.status !== 'CONFIRMED' || proof) ? matchedTx.status : 'SUBMITTED'];
  return <div className="library-recovery"><p><strong>{libraryLabels[action]}</strong> · {label}</p>
    {storedHash ? <details><summary>Chi tiết biên nhận và mã giao dịch</summary><code>{storedHash}</code>
      {proof ? <p>Receipt đã xác minh · block {proof.blockNumber} · {proof.eventName}</p> : null}</details>
      : <p>Lượt ký bị ngắt trước khi nhận hash. Không gửi lại; đối chiếu request hoặc lấy hash từ lịch sử ví.</p>}
    <button type="button" className="secondary-btn" disabled={busy || !transactions} onClick={() => onRecover(request.requestId, action, storedHash ?? undefined)}>Đối chiếu {libraryLabels[action].toLowerCase()}</button>
    {!storedHash ? <form onSubmit={e => { e.preventDefault(); onRecover(request.requestId, action, hash.trim()); }}>
      <label className="field-label" htmlFor={`recover-${request.requestId}-${action}`}>Hash {libraryLabels[action].toLowerCase()} từ ví</label>
      <input id={`recover-${request.requestId}-${action}`} value={hash} onChange={e => setHash(e.target.value)} pattern="0x[0-9a-fA-F]{64}" required aria-describedby={`hint-${request.requestId}-${action}`} />
      <p id={`hint-${request.requestId}-${action}`} className="metric-note">0x và 64 ký tự hex. Chỉ gửi hash để xác minh, không gửi giao dịch mới.</p>
      <button className="secondary-btn" disabled={busy || !transactions} type="submit">Kiểm tra hash</button>
    </form> : null}
  </div>;
}
