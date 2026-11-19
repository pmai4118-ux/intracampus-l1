import { useEffect, useMemo, useState } from 'react';
import type { LibraryBook, LibraryLoan, LibrarySettlement } from '@intracampus/network';
import { formatWalletBalance, formatWalletBalanceCompact } from '../../../lib/chains';
import { libraryDate, libraryLabels } from '../../../lib/library';
import HashChip from '../../components/HashChip';
import PaginationBar from '../../components/PaginationBar';

const moneyCompact = (weiStr: string) => formatWalletBalanceCompact(BigInt(weiStr), 2).display;
const shortDate = (s: number | null) =>
  s === null ? '—' : new Date(s * 1000).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

const ACTIVE_PRIORITY: Record<string, number> = {
  LOST_SHORTFALL_DUE: 0,
  SETTLEMENT_PENDING: 1,
  RETURN_REQUESTED: 2,
  ACTIVE: 3,
};

function studentCashBadge(settlement: LibrarySettlement): { label: string; tone: 'ok' | 'warn' | 'danger' } {
  const refund = BigInt(settlement.refundWei);
  const retained = BigInt(settlement.totalRetainedWei);
  if (settlement.outcome === 'LOST') {
    const shortfall = BigInt(settlement.shortfallWei);
    if (shortfall > BigInt(0)) return { label: `Giữ ${moneyCompact(retained.toString())} · Đã bù ${moneyCompact(shortfall.toString())}`, tone: 'danger' };
    if (refund > BigInt(0)) return { label: `Nhận lại ${moneyCompact(refund.toString())} · Giữ ${moneyCompact(retained.toString())}`, tone: 'warn' };
    return { label: `Giữ cọc ${moneyCompact(retained.toString())}`, tone: 'warn' };
  }
  if (retained === BigInt(0)) return { label: `Nhận đủ ${moneyCompact(refund.toString())}`, tone: 'ok' };
  return { label: `Nhận lại ${moneyCompact(refund.toString())} · Khấu trừ ${moneyCompact(retained.toString())}`, tone: 'warn' };
}

function StudentSettlementBreakdown({ settlement }: { settlement: LibrarySettlement }) {
  return (
    <div className="settlement-breakdown-wrap">
      {settlement.outcome === 'RETURNED' ? (
        <dl className="settlement-components-grid">
          <div>
            <dt>Phí trễ</dt>
            <dd className="tabular-value">{formatWalletBalance(BigInt(settlement.lateFeeWei))}</dd>
          </div>
          <div>
            <dt>Sửa chữa</dt>
            <dd className="tabular-value">{formatWalletBalance(BigInt(settlement.repairFeeWei))}</dd>
          </div>
        </dl>
      ) : null}
      <dl className="settlement-summary-highlight">
        <div className="summary-retained-box">
          <dt>Đã giữ/khấu trừ</dt>
          <dd className="tabular-value">{formatWalletBalance(BigInt(settlement.totalRetainedWei))}</dd>
        </div>
        <div className="summary-refund-box">
          <dt>Hoàn về ví mượn</dt>
          <dd className="tabular-value">{formatWalletBalance(BigInt(settlement.refundWei))}</dd>
        </div>
        {settlement.outcome === 'LOST' ? (
          <div className="summary-shortfall-box">
            <dt>Phần thiếu khi quyết toán</dt>
            <dd className="tabular-value">{formatWalletBalance(BigInt(settlement.shortfallWei))}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

export default function LibraryLoans({
  loans,
  books,
  busy,
  onReturn,
  onShortfall,
}: {
  loans: LibraryLoan[];
  books: LibraryBook[];
  busy: boolean;
  onReturn(loan: LibraryLoan): void;
  onShortfall(loan: LibraryLoan): void;
}) {
  const bookMap = useMemo(() => new Map<string, LibraryBook>(books.map(b => [b.bookId, b])), [books]);
  const titleOf = (bookId: string) => bookMap.get(bookId)?.title ?? 'Sách đã mượn';

  const activeLoans = useMemo(
    () =>
      loans
        .filter(l => !['RETURNED', 'LOST_SETTLED'].includes(l.status))
        .sort((a, b) => (ACTIVE_PRIORITY[a.status] ?? 9) - (ACTIVE_PRIORITY[b.status] ?? 9) || a.dueAt - b.dueAt),
    [loans],
  );
  const settledLoans = useMemo(
    () => loans.filter(l => ['RETURNED', 'LOST_SETTLED'].includes(l.status)),
    [loans],
  );

  const [activePage, setActivePage] = useState(1);
  const [activePageSize, setActivePageSize] = useState(5);
  const [historyFilter, setHistoryFilter] = useState<'all' | 'full-refund' | 'deducted'>('all');
  const [historyDensity, setHistoryDensity] = useState<'auto' | 'compact' | 'detailed'>('auto');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(6);

  const filteredSettled = useMemo(
    () =>
      settledLoans.filter(l => {
        if (historyFilter === 'all') return true;
        if (!l.settlement) return false;
        const isFull = l.settlement.outcome === 'RETURNED' && BigInt(l.settlement.totalRetainedWei) === BigInt(0);
        return historyFilter === 'full-refund' ? isFull : !isFull;
      }),
    [settledLoans, historyFilter],
  );

  useEffect(() => {
    setHistoryPage(1);
  }, [historyFilter, settledLoans.length]);

  const isCompactLedger = historyDensity === 'compact' || (historyDensity === 'auto' && settledLoans.length > 3);

  const activeSize = activePageSize <= 0 ? Math.max(1, activeLoans.length) : activePageSize;
  const safeActivePage = Math.min(activePage, Math.max(1, Math.ceil(activeLoans.length / activeSize)));
  const pagedActive = activeLoans.slice((safeActivePage - 1) * activeSize, safeActivePage * activeSize);

  const historySize = historyPageSize <= 0 ? Math.max(1, filteredSettled.length) : historyPageSize;
  const safeHistoryPage = Math.min(historyPage, Math.max(1, Math.ceil(filteredSettled.length / historySize)));
  const pagedSettled = filteredSettled.slice((safeHistoryPage - 1) * historySize, safeHistoryPage * historySize);

  return (
    <section className="surface-panel library-section" aria-labelledby="loans-title">
      <span className="eyebrow">03 / Theo dõi & trả sách</span>
      <h2 id="loans-title">Khoản mượn & lịch sử nhận cọc ({loans.length})</h2>
      {loans.length === 0 ? (
        <p>Chưa có khoản mượn. Yêu cầu đã cọc cần được thủ thư duyệt trước.</p>
      ) : (
        <div className="staff-loans-layers">
          {/* Tầng A: Khoản đang mượn hoặc cần thanh toán phần thiếu */}
          {activeLoans.length > 0 ? (
            <div className="staff-active-layer">
              {settledLoans.length > 0 ? (
                <h3 className="layer-heading">Đang mượn & cần xử lý ({activeLoans.length})</h3>
              ) : null}
              <ul className="library-list">
                {pagedActive.map(loan => (
                  <li className="library-record staff-record" key={loan.loanId} id={`loan-${loan.loanId}`}>
                    <div className="staff-record-head">
                      <div className="staff-record-main">
                        <div className="staff-title-row">
                          <h3>{titleOf(loan.bookId)}</h3>
                          <span className={`network-pill ${loan.status === 'LOST_SHORTFALL_DUE' ? 'pill-danger' : 'pill-warning'}`}>
                            {libraryLabels[loan.status]}
                          </span>
                        </div>
                        <div className="staff-meta-chips">
                          <span>
                            Mã khoản mượn: <HashChip value={loan.loanId} copyLabel="Sao chép mã khoản mượn" />
                          </span>
                        </div>
                      </div>
                      <div className="library-actions staff-actions-right">
                        {loan.status === 'ACTIVE' ? (
                          <button className="secondary-btn" type="button" disabled={busy} onClick={() => onReturn(loan)}>
                            Yêu cầu trả sách
                          </button>
                        ) : null}
                        {loan.status === 'LOST_SHORTFALL_DUE' ? (
                          <button className="primary-cta-btn" type="button" disabled={busy} onClick={() => onShortfall(loan)}>
                            Xem phần thiếu trước khi ký
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <dl className="loan-timeline-grid">
                      <div>
                        <dt>Ngày duyệt</dt>
                        <dd className="tabular-value">{libraryDate(loan.approvedAt)}</dd>
                      </div>
                      <div>
                        <dt>Hạn trả</dt>
                        <dd className="tabular-value">{libraryDate(loan.dueAt)}</dd>
                      </div>
                      <div>
                        <dt>Yêu cầu trả</dt>
                        <dd className="tabular-value">{libraryDate(loan.returnRequestedAt)}</dd>
                      </div>
                      <div>
                        <dt>Thủ thư nhận sách</dt>
                        <dd className="tabular-value">{libraryDate(loan.returnReceivedAt)}</dd>
                      </div>
                    </dl>
                    {loan.status === 'RETURN_REQUESTED' ? (
                      <p>Đưa sách cho thủ thư kiểm tra. Yêu cầu trả chưa xác nhận sách đã được nhận.</p>
                    ) : null}
                    {loan.settlement ? <StudentSettlementBreakdown settlement={loan.settlement} /> : null}
                  </li>
                ))}
              </ul>
              <PaginationBar
                total={activeLoans.length}
                page={safeActivePage}
                pageSize={activePageSize}
                onPage={setActivePage}
                onPageSize={setActivePageSize}
                sizes={[5, 10, 0]}
                unitLabel="khoản đang mượn"
              />
            </div>
          ) : null}

          {/* Tầng B: Sổ cái lịch sử nhận lại tiền cọc & tất toán */}
          {settledLoans.length > 0 ? (
            <div className={activeLoans.length > 0 ? 'staff-history-ledger' : 'staff-active-layer'}>
              <div className="staff-section-top">
                <div>
                  <h3 className="layer-heading">Lịch sử nhận cọc & tất toán ({settledLoans.length})</h3>
                  <p className="muted-line">Đối soát số CAMPUS hoàn về ví mượn và các khoản phí trễ / sửa chữa đã khấu trừ.</p>
                </div>
                <div className="ledger-toolbar-controls">
                  {settledLoans.length > 1 ? (
                    <div className="segmented-row" role="group" aria-label="Lọc lịch sử nhận cọc">
                      {(
                        [
                          ['all', `Tất cả (${settledLoans.length})`],
                          ['full-refund', 'Nhận đủ 50 CAMPUS'],
                          ['deducted', 'Có khấu trừ / sách mất'],
                        ] as const
                      ).map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          className={`seg-btn ${historyFilter === key ? 'active' : ''}`}
                          aria-pressed={historyFilter === key}
                          onClick={() => setHistoryFilter(key)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {settledLoans.length > 1 ? (
                    <div className="segmented-row" role="group" aria-label="Mật độ sổ cái nhận cọc">
                      <button
                        type="button"
                        className={`seg-btn ${isCompactLedger ? 'active' : ''}`}
                        aria-pressed={isCompactLedger}
                        onClick={() => setHistoryDensity('compact')}
                      >
                        Thu gọn 1 dòng
                      </button>
                      <button
                        type="button"
                        className={`seg-btn ${!isCompactLedger ? 'active' : ''}`}
                        aria-pressed={!isCompactLedger}
                        onClick={() => setHistoryDensity('detailed')}
                      >
                        Chi tiết đầy đủ
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              {filteredSettled.length === 0 ? (
                <p className="muted-line">Không có lượt quyết toán nào trong nhóm lọc này.</p>
              ) : (
                <>
                  <ul className={isCompactLedger ? 'library-list ledger-compact-list' : 'library-list'}>
                    {pagedSettled.map(loan => {
                      const isExpanded = !isCompactLedger || Boolean(expandedIds[loan.loanId]);
                      const badge = loan.settlement ? studentCashBadge(loan.settlement) : null;
                      const dateStr =
                        loan.settlement?.outcome === 'RETURNED'
                          ? shortDate(loan.settlement.returnedAt)
                          : shortDate(loan.dueAt);

                      if (!isCompactLedger) {
                        return (
                          <li className="library-record staff-record" key={loan.loanId} id={`loan-${loan.loanId}`}>
                            <div className="staff-record-head">
                              <div className="staff-record-main">
                                <div className="staff-title-row">
                                  <h3>{titleOf(loan.bookId)}</h3>
                                  <span className="network-pill pill-ok">{libraryLabels[loan.status]}</span>
                                </div>
                                <div className="staff-meta-chips">
                                  <span>
                                    Mã khoản mượn: <HashChip value={loan.loanId} copyLabel="Sao chép mã khoản mượn" />
                                  </span>
                                </div>
                              </div>
                            </div>
                            <dl className="loan-timeline-grid">
                              <div>
                                <dt>Ngày duyệt</dt>
                                <dd className="tabular-value">{libraryDate(loan.approvedAt)}</dd>
                              </div>
                              <div>
                                <dt>Hạn trả</dt>
                                <dd className="tabular-value">{libraryDate(loan.dueAt)}</dd>
                              </div>
                              <div>
                                <dt>Yêu cầu trả</dt>
                                <dd className="tabular-value">{libraryDate(loan.returnRequestedAt)}</dd>
                              </div>
                              <div>
                                <dt>Thủ thư nhận sách</dt>
                                <dd className="tabular-value">{libraryDate(loan.returnReceivedAt)}</dd>
                              </div>
                            </dl>
                            {loan.settlement ? <StudentSettlementBreakdown settlement={loan.settlement} /> : null}
                          </li>
                        );
                      }

                      return (
                        <li
                          className={`library-record ledger-compact-row ${isExpanded ? 'ledger-row-expanded' : ''}`}
                          key={loan.loanId}
                          id={`loan-${loan.loanId}`}
                        >
                          <div className="ledger-row-summary">
                            <span className="ledger-date tabular-value">{dateStr}</span>
                            <div className="ledger-book-cell">
                              <strong>{titleOf(loan.bookId)}</strong>
                              <span className="network-pill pill-ok">{libraryLabels[loan.status]}</span>
                            </div>
                            {badge ? (
                              <span
                                className={`network-pill ledger-cash-pill ${
                                  badge.tone === 'ok' ? 'pill-ok' : badge.tone === 'danger' ? 'pill-danger' : 'pill-warning'
                                }`}
                              >
                                {badge.label}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="hash-chip-btn ledger-toggle-btn"
                              aria-expanded={isExpanded}
                              onClick={() => setExpandedIds(prev => ({ ...prev, [loan.loanId]: !prev[loan.loanId] }))}
                            >
                              {isExpanded ? 'Ẩn chi tiết ▴' : 'Chi tiết ▾'}
                            </button>
                          </div>
                          {isExpanded ? (
                            <div className="ledger-row-details">
                              <div className="staff-meta-chips">
                                <span>
                                  Mã khoản mượn: <HashChip value={loan.loanId} copyLabel="Sao chép mã khoản mượn" />
                                </span>
                              </div>
                              <dl className="loan-timeline-grid">
                                <div>
                                  <dt>Ngày duyệt</dt>
                                  <dd className="tabular-value">{libraryDate(loan.approvedAt)}</dd>
                                </div>
                                <div>
                                  <dt>Hạn trả</dt>
                                  <dd className="tabular-value">{libraryDate(loan.dueAt)}</dd>
                                </div>
                                <div>
                                  <dt>Thủ thư nhận sách</dt>
                                  <dd className="tabular-value">{libraryDate(loan.returnReceivedAt)}</dd>
                                </div>
                              </dl>
                              {loan.settlement ? <StudentSettlementBreakdown settlement={loan.settlement} /> : null}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  <PaginationBar
                    total={filteredSettled.length}
                    page={safeHistoryPage}
                    pageSize={historyPageSize}
                    onPage={setHistoryPage}
                    onPageSize={setHistoryPageSize}
                    sizes={[6, 12, 0]}
                    unitLabel="lượt quyết toán"
                  />
                </>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
