'use client';
import type { LibraryBook, LibraryLoan } from '@intracampus/network';
import { formatWalletBalance } from '../../../lib/chains';
import { libraryDate, libraryLabels } from '../../../lib/library';

export default function LibraryLoans({ loans, books, busy, onReturn, onShortfall }: {
  loans: LibraryLoan[]; books: LibraryBook[]; busy: boolean; onReturn(loan: LibraryLoan): void; onShortfall(loan: LibraryLoan): void;
}) {
  return <section className="surface-panel library-section" aria-labelledby="loans-title">
    <span className="eyebrow">03 / Theo dõi & trả sách</span><h2 id="loans-title">Khoản mượn của bạn</h2>
    {loans.length === 0 ? <p>Chưa có khoản mượn. Yêu cầu đã cọc cần được thủ thư duyệt trước.</p> : null}
    <ul className="library-list">{loans.map(loan => <li className="library-record" key={loan.loanId} id={`loan-${loan.loanId}`}>
      <h3>{books.find(b => b.bookId === loan.bookId)?.title ?? 'Sách đã mượn'}</h3>
      <p className="network-pill">{libraryLabels[loan.status]}</p>
      <dl className="library-details"><dt>Mã khoản mượn</dt><dd><code>{loan.loanId}</code></dd>
        <dt>Ngày duyệt</dt><dd>{libraryDate(loan.approvedAt)}</dd><dt>Hạn trả</dt><dd>{libraryDate(loan.dueAt)}</dd>
        <dt>Yêu cầu trả</dt><dd>{libraryDate(loan.returnRequestedAt)}</dd><dt>Thủ thư nhận sách</dt><dd>{libraryDate(loan.returnReceivedAt)}</dd></dl>
      {loan.status === 'ACTIVE' ? <button className="secondary-btn" type="button" disabled={busy} onClick={() => onReturn(loan)}>Yêu cầu trả sách</button> : null}
      {loan.status === 'RETURN_REQUESTED' ? <p>Đưa sách cho thủ thư kiểm tra. Yêu cầu trả chưa xác nhận sách đã được nhận.</p> : null}
      {loan.settlement ? <dl className="price-breakdown"><div className="price-row"><dt>Đã giữ/khấu trừ</dt><dd>{formatWalletBalance(BigInt(loan.settlement.totalRetainedWei))}</dd></div>
        <div className="price-row"><dt>Hoàn về ví mượn</dt><dd>{formatWalletBalance(BigInt(loan.settlement.refundWei))}</dd></div>
        {loan.settlement.outcome === 'RETURNED' ? <>
          <div className="price-row"><dt>Phí trễ</dt><dd>{formatWalletBalance(BigInt(loan.settlement.lateFeeWei))}</dd></div>
          <div className="price-row"><dt>Sửa chữa</dt><dd>{formatWalletBalance(BigInt(loan.settlement.repairFeeWei))}</dd></div>
        </> : <div className="price-row"><dt>Phần thiếu khi quyết toán</dt><dd>{formatWalletBalance(BigInt(loan.settlement.shortfallWei))}</dd></div>}</dl> : null}
      {loan.status === 'LOST_SHORTFALL_DUE' ? <button className="primary-cta-btn" type="button" disabled={busy} onClick={() => onShortfall(loan)}>Xem phần thiếu trước khi ký</button> : null}
    </li>)}</ul>
  </section>;
}
