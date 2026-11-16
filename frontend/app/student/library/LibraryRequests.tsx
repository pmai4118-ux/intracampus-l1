import { useState } from 'react';
import type { LibraryBook, LibraryRequest } from '@intracampus/network';
import { canClaimLibraryRefund, libraryDate, libraryLabels, libraryRecoveryDetails } from '../../../lib/library';
import { LibraryTransactions, type StudentAction } from '../../../lib/library-transactions';

export default function LibraryRequests({ requests, books, transactions, busy, blocked, chainTime, walletReady, onPrepare, onRecover }: {
  requests: LibraryRequest[]; books: LibraryBook[]; transactions: LibraryTransactions | null; busy: boolean; blocked: boolean;
  chainTime: number | null; walletReady: boolean;
  onPrepare(id: string, action: StudentAction): void; onRecover(id: string, action: StudentAction, hash?: string): void;
}) {
  return <section className="surface-panel library-section" aria-labelledby="requests-title"><span className="eyebrow">02 / Nộp cọc & chờ duyệt</span>
    <h2 id="requests-title">Yêu cầu của bạn</h2>{requests.length === 0 ? <p>Chưa có yêu cầu mượn.</p> : null}
    <ul className="library-list">{requests.map(request => <li className="library-record" key={request.requestId}>
      <h3>{books.find(book => book.bookId === request.bookId)?.title ?? 'Yêu cầu mượn sách'}</h3>
      <p className="network-pill">{request.refundStatus === 'REFUNDED' && request.status === 'REJECTED_NO_COPY'
        ? 'Hết bản · đã hoàn cọc' : request.refundStatus === 'REFUNDED' && request.status === 'EXPIRED_REFUND_DUE'
          ? 'Hết hạn duyệt · đã hoàn cọc' : libraryLabels[request.status]}</p>
      <dl className="library-details"><dt>Mã yêu cầu</dt><dd><code>{request.requestId}</code></dd><dt>Hạn duyệt</dt><dd>{libraryDate(request.approvalDeadline)}</dd>
        <dt>Hoàn cọc</dt><dd>{libraryLabels[request.refundStatus]}</dd></dl>
      {request.status === 'PENDING_APPROVAL' ? <p>Cọc đã xác minh. Khoản mượn chưa hoạt động; đang chờ thủ thư duyệt trước hạn trên.</p> : null}
      {request.status === 'REJECTED_NO_COPY' && request.refundStatus === 'REFUND_DUE'
        ? <p>Không còn bản sau khi cọc. Thủ thư có thể từ chối để hoàn tiền; bạn có thể nhận lại cọc khi hết hạn duyệt.</p> : null}
      {request.status === 'AWAITING_DEPOSIT' ? <button type="button" className="primary-cta-btn" disabled={busy || blocked || !transactions || !request.depositIntent}
        onClick={() => onPrepare(request.requestId, 'deposit')}>Xem cọc trước khi ký</button> : null}
      {canClaimLibraryRefund(request, chainTime) ? <button type="button" className="secondary-btn" disabled={busy || !transactions || !walletReady}
        onClick={() => onPrepare(request.requestId, 'refund')}>Xem hoàn cọc hết hạn</button> : null}
      {(['deposit','refund','payShortfall'] as StudentAction[]).map(action => <Recovery key={action} request={request} action={action}
        transactions={transactions} busy={busy} onRecover={onRecover} />)}
      {request.transactions.filter(tx => !['deposit','refund','payShortfall'].includes(tx.action)).map(tx => <p key={tx.action}>
        {libraryLabels[tx.action] ?? tx.action}: {libraryLabels[tx.status === 'CONFIRMED' && !transactions?.confirmedProof(request.requestId, tx) ? 'SUBMITTED' : tx.status]}<br /><code>{tx.txHash}</code>
      </p>)}
    </li>)}</ul>
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
  const tx = request.transactions.find(t => t.action === action);
  if (!record && !tx) return null;
  const unknown = record?.phase === 'unknown' && !record.hash;
  const { hash: storedHash, matchedTx } = libraryRecoveryDetails(record, tx);
  const proof = transactions?.confirmedProof(request.requestId, matchedTx);
  const label = unknown ? 'Chưa rõ ví đã gửi hay chưa'
    : libraryLabels[matchedTx && (matchedTx.status !== 'CONFIRMED' || proof) ? matchedTx.status : 'SUBMITTED'];
  return <div className="library-recovery"><p><strong>{libraryLabels[action]}</strong> · {label}</p>
    {storedHash ? <code>{storedHash}</code> : <p>Lượt ký bị ngắt trước khi nhận hash. Không gửi lại; đối chiếu request hoặc lấy hash từ lịch sử ví.</p>}
    {proof ? <p>Receipt đã xác minh · block {proof.blockNumber} · {proof.eventName}</p> : null}
    <button type="button" className="secondary-btn" disabled={busy || !transactions} onClick={() => onRecover(request.requestId, action, storedHash ?? undefined)}>Đối chiếu {libraryLabels[action].toLowerCase()}</button>
    {!storedHash ? <form onSubmit={e => { e.preventDefault(); onRecover(request.requestId, action, hash.trim()); }}>
      <label className="field-label" htmlFor={`recover-${request.requestId}-${action}`}>Hash {libraryLabels[action].toLowerCase()} từ ví</label>
      <input id={`recover-${request.requestId}-${action}`} value={hash} onChange={e => setHash(e.target.value)} pattern="0x[0-9a-fA-F]{64}" required aria-describedby={`hint-${request.requestId}-${action}`} />
      <p id={`hint-${request.requestId}-${action}`} className="metric-note">0x và 64 ký tự hex. Chỉ gửi hash để xác minh, không gửi giao dịch mới.</p>
      <button className="secondary-btn" disabled={busy || !transactions} type="submit">Kiểm tra hash</button>
    </form> : null}
  </div>;
}
