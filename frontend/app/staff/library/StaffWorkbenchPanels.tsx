'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LibraryBook, LibraryLoan, LibraryRequest, LibrarySettlement } from '@intracampus/network';
import { formatWalletBalanceCompact, isWalletAddress } from '../../../lib/chains';
import { libraryTransactionProof } from '../../../lib/library-api';
import { libraryLabels } from '../../../lib/library';
import HashChip from '../../components/HashChip';
import Icon from '../../components/Icon';
import BookCover from '../../components/BookCover';
import PaginationBar from '../../components/PaginationBar';

export { PaginationBar };

const moneyCompact = (weiStr: string) => formatWalletBalanceCompact(BigInt(weiStr), 2).display;
const dateLabel = (s: number | null) => (s === null ? '—' : new Date(s * 1000).toLocaleString('vi-VN'));
const shortDate = (s: number | null) =>
  s === null ? '—' : new Date(s * 1000).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

export function StaffEscrowKpiStrip({
  books,
  requests,
  loans,
  onSelectTab,
}: {
  books: LibraryBook[];
  requests: LibraryRequest[];
  loans: LibraryLoan[];
  onSelectTab: (tab: 'queue' | 'loans' | 'catalog') => void;
}) {
  const stats = useMemo(() => {
    const queueDepositWei = requests.reduce((sum, r) => sum + BigInt(r.depositWei ?? '0'), BigInt(0));
    const activeLoans = loans.filter(l => !['RETURNED', 'LOST_SETTLED'].includes(l.status));
    const urgentCount = activeLoans.filter(l => ['SETTLEMENT_PENDING', 'RETURN_REQUESTED', 'LOST_SHORTFALL_DUE'].includes(l.status)).length;
    const settledLoans = loans.filter(l => ['RETURNED', 'LOST_SETTLED'].includes(l.status));
    const refundedWei = loans.reduce((sum, l) => sum + BigInt(l.settlement?.refundWei ?? '0'), BigInt(0));
    const retainedWei = loans.reduce((sum, l) => sum + BigInt(l.settlement?.totalRetainedWei ?? '0'), BigInt(0));
    const totalCopies = books.reduce((sum, b) => sum + b.copiesTotal, 0);
    const availableCopies = books.reduce((sum, b) => sum + b.copiesAvailable, 0);
    const outOfStockTitles = books.filter(b => b.copiesAvailable === 0).length;
    return {
      queueDepositWei,
      activeCount: activeLoans.length,
      urgentCount,
      settledCount: settledLoans.length,
      refundedWei,
      retainedWei,
      totalCopies,
      availableCopies,
      outOfStockTitles,
    };
  }, [books, requests, loans]);

  return (
    <div className="staff-kpi-strip" role="region" aria-label="Tổng quan vận hành thư viện">
      <button type="button" className="staff-kpi-card" onClick={() => onSelectTab('queue')}>
        <span className="kpi-label">Chờ duyệt mượn</span>
        <strong className="kpi-value tabular-value">{requests.length} yêu cầu</strong>
        <span className="kpi-sub tabular-value">Cọc đang chờ: {moneyCompact(stats.queueDepositWei.toString())}</span>
      </button>
      <button type="button" className="staff-kpi-card" onClick={() => onSelectTab('loans')}>
        <span className="kpi-label">Khoản mượn đang mở</span>
        <strong className="kpi-value tabular-value">{stats.activeCount} khoản</strong>
        <span className={`kpi-sub ${stats.urgentCount > 0 ? 'kpi-sub-warn' : ''}`}>
          {stats.urgentCount > 0 ? `${stats.urgentCount} đơn cần xử lý trả / thu thiếu` : 'Chưa có đơn báo trả gấp'}
        </span>
      </button>
      <button type="button" className="staff-kpi-card" onClick={() => onSelectTab('catalog')}>
        <span className="kpi-label">Tồn kho giáo trình</span>
        <strong className="kpi-value tabular-value">
          {stats.availableCopies}/{stats.totalCopies} bản
        </strong>
        <span className={`kpi-sub ${stats.outOfStockTitles > 0 ? 'kpi-sub-warn' : ''}`}>
          {books.length} đầu sách{stats.outOfStockTitles > 0 ? ` · ${stats.outOfStockTitles} hết bản` : ' · Đều còn bản'}
        </span>
      </button>
      <button type="button" className="staff-kpi-card" onClick={() => onSelectTab('loans')}>
        <span className="kpi-label">Dòng tiền đã quyết toán ({stats.settledCount})</span>
        <strong className="kpi-value kpi-emerald tabular-value">Hoàn {moneyCompact(stats.refundedWei.toString())}</strong>
        <span className="kpi-sub tabular-value">Giữ về quỹ: {moneyCompact(stats.retainedWei.toString())}</span>
      </button>
    </div>
  );
}

export function StaffSearchToolbar({
  search,
  onSearch,
  serverWalletFilter,
  onApplyServerWallet,
  busy,
}: {
  search: string;
  onSearch: (next: string) => void;
  serverWalletFilter?: string | null;
  onApplyServerWallet?: (wallet: string | null) => void;
  busy?: boolean;
}) {
  const trimmed = search.trim();
  const canQueryServerWallet = Boolean(onApplyServerWallet && isWalletAddress(trimmed) && trimmed.toLowerCase() !== (serverWalletFilter ?? '').toLowerCase());

  return (
    <div className="staff-search-toolbar">
      <div className="staff-search-input-wrap">
        <label htmlFor="staff-global-search" className="sr-only">
          Tìm theo tên sách, ISBN, mã khoản mượn hoặc địa chỉ ví sinh viên
        </label>
        <input
          id="staff-global-search"
          type="search"
          placeholder="Tìm nhanh theo tên sách, ISBN, mã yêu cầu hoặc địa chỉ ví 0x…"
          value={search}
          onChange={e => onSearch(e.target.value)}
        />
        {search ? (
          <button type="button" className="text-action-btn staff-clear-search" onClick={() => onSearch('')}>
            Xóa lọc
          </button>
        ) : null}
      </div>
      {canQueryServerWallet ? (
        <button
          type="button"
          className="secondary-btn"
          disabled={busy}
          onClick={() => onApplyServerWallet!(trimmed)}
        >
          Tra cứu ví này từ Server
        </button>
      ) : null}
      {serverWalletFilter && onApplyServerWallet ? (
        <span className="network-pill pill-ok">
          Đang lọc ví trên Server: {serverWalletFilter.slice(0, 6)}…{serverWalletFilter.slice(-4)}{' '}
          <button type="button" className="link-action-btn" disabled={busy} onClick={() => onApplyServerWallet(null)}>
            Bỏ lọc
          </button>
        </span>
      ) : null}
    </div>
  );
}

export function StaffQueuePanel({
  requests,
  titleOf,
  escrow,
  loading,
  busy,
  journalUnavailable,
  walletReady,
  demoMode = false,
  onApprove,
  onReject,
}: {
  requests: LibraryRequest[];
  titleOf: (bookId: string) => string;
  escrow: string;
  loading: boolean;
  busy: boolean;
  journalUnavailable: boolean;
  walletReady: boolean;
  demoMode?: boolean;
  onApprove: (request: LibraryRequest) => void;
  onReject: (request: LibraryRequest) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'pending' | 'no-copy'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);

  const sorted = useMemo(() => {
    const filtered = requests.filter(r => {
      if (filter === 'pending') return r.status === 'PENDING_APPROVAL';
      if (filter === 'no-copy') return r.status === 'REJECTED_NO_COPY';
      return true;
    });
    return [...filtered].sort((a, b) => (a.approvalDeadline ?? Number.MAX_SAFE_INTEGER) - (b.approvalDeadline ?? Number.MAX_SAFE_INTEGER));
  }, [requests, filter]);

  useEffect(() => { setPage(1); }, [filter, requests.length]);

  const effectiveSize = pageSize <= 0 ? Math.max(1, sorted.length) : pageSize;
  const safePage = Math.min(page, Math.max(1, Math.ceil(sorted.length / effectiveSize)));
  const paged = sorted.slice((safePage - 1) * effectiveSize, safePage * effectiveSize);
  const noCopyCount = requests.filter(r => r.status === 'REJECTED_NO_COPY').length;

  return (
    <section className="surface-panel library-section" aria-label={demoMode ? 'Hàng chờ duyệt mẫu' : 'Hàng chờ duyệt'}>
      <div className="staff-section-top">
        <div>
          <span className="eyebrow">01 / Duyệt yêu cầu mượn{demoMode ? ' (Mẫu)' : ''}</span>
          <h2>Yêu cầu chờ duyệt ({requests.length})</h2>
        </div>
        {requests.length > 0 ? (
          <div className="segmented-row" role="group" aria-label="Lọc hàng chờ duyệt">
            <button type="button" className={`seg-btn ${filter === 'all' ? 'active' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              Tất cả ({requests.length})
            </button>
            <button type="button" className={`seg-btn ${filter === 'pending' ? 'active' : ''}`} aria-pressed={filter === 'pending'} onClick={() => setFilter('pending')}>
              Còn bản ({requests.length - noCopyCount})
            </button>
            {noCopyCount > 0 ? (
              <button type="button" className={`seg-btn ${filter === 'no-copy' ? 'active' : ''}`} aria-pressed={filter === 'no-copy'} onClick={() => setFilter('no-copy')}>
                Hết bản · chờ hoàn ({noCopyCount})
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {loading ? (
        <p>Đang tải…</p>
      ) : sorted.length === 0 ? (
        <p>Không có yêu cầu chờ duyệt phù hợp.</p>
      ) : (
        <>
          <div className="library-list">
            {paged.map(r => {
              const deposit = demoMode
                ? r.transactions.find(tx => tx.action === 'deposit')?.proof ?? null
                : libraryTransactionProof(r.transactions.find(tx => tx.action === 'deposit'), r.requestId, escrow);
              const canReject = r.status === 'PENDING_APPROVAL' || (r.status === 'REJECTED_NO_COPY' && r.refundStatus === 'REFUND_DUE');
              const disabled = demoMode ? false : busy || journalUnavailable || !deposit || !walletReady;
              return (
                <article className="library-record staff-record" aria-label={'Yêu cầu ' + r.requestId} key={r.requestId}>
                  <div className="staff-record-head">
                    <div className="staff-record-main">
                      <div className="staff-title-row">
                        <h3>{titleOf(r.bookId)}</h3>
                        <span className={`network-pill ${r.status === 'PENDING_APPROVAL' ? 'pill-warning' : 'pill-danger'}`}>
                          {libraryLabels[r.status] ?? 'Chưa xác minh'}
                        </span>
                      </div>
                      <div className="staff-meta-chips">
                        <span>Mã yêu cầu: <HashChip value={r.requestId} copyLabel="Sao chép mã yêu cầu" /></span>
                        <span>
                          Người mượn:{' '}
                          {deposit?.borrower ? (
                            <HashChip value={deposit.borrower} copyLabel="Sao chép ví người mượn" />
                          ) : (
                            <code>Chưa có bằng chứng hợp lệ</code>
                          )}
                        </span>
                      </div>
                    </div>
                    <div className="library-actions staff-actions-right">
                      {r.status === 'PENDING_APPROVAL' ? (
                        <button type="button" className="primary-cta-btn" disabled={disabled} onClick={() => onApprove(r)}>
                          Duyệt
                        </button>
                      ) : null}
                      {canReject ? (
                        <button type="button" className="secondary-btn" disabled={disabled} onClick={() => onReject(r)}>
                          Từ chối
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <dl className="loan-timeline-grid">
                    <div>
                      <dt>Hạn duyệt (ưu tiên hạn gần)</dt>
                      <dd className="tabular-value">{dateLabel(r.approvalDeadline)}</dd>
                    </div>
                    <div>
                      <dt>Tiền cọc Escrow</dt>
                      <dd className="tabular-value">{r.depositWei ? moneyCompact(r.depositWei) : '—'}</dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
          <PaginationBar
            total={sorted.length}
            page={safePage}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={setPageSize}
            sizes={[5, 10, 0]}
            unitLabel="yêu cầu"
          />
        </>
      )}
    </section>
  );
}

const ACTIVE_PRIORITY: Record<string, number> = {
  SETTLEMENT_PENDING: 0,
  RETURN_REQUESTED: 1,
  LOST_SHORTFALL_DUE: 2,
  ACTIVE: 3,
};

function cashflowBadge(settlement: LibrarySettlement): { label: string; tone: 'ok' | 'warn' | 'danger' } {
  const refund = BigInt(settlement.refundWei);
  const retained = BigInt(settlement.totalRetainedWei);
  if (settlement.outcome === 'LOST') {
    const shortfall = BigInt(settlement.shortfallWei);
    if (shortfall > BigInt(0)) {
      return { label: `Giữ ${moneyCompact(retained.toString())} · Thu thêm ${moneyCompact(shortfall.toString())}`, tone: 'danger' };
    }
    if (refund > BigInt(0)) {
      return { label: `Hoàn ${moneyCompact(refund.toString())} · Giữ ${moneyCompact(retained.toString())}`, tone: 'warn' };
    }
    return { label: `Giữ toàn bộ ${moneyCompact(retained.toString())}`, tone: 'warn' };
  }
  if (retained === BigInt(0)) {
    return { label: `Hoàn đủ ${moneyCompact(refund.toString())}`, tone: 'ok' };
  }
  return { label: `Hoàn ${moneyCompact(refund.toString())} · Khấu trừ ${moneyCompact(retained.toString())}`, tone: 'warn' };
}

export function StaffLoansWorkbench({
  loans,
  titleOf,
  busy,
  journalUnavailable,
  walletReady,
  demoMode = false,
  renderSettlementDetails,
  onConfirmReturn,
  onSettleReturn,
  onReportLost,
}: {
  loans: LibraryLoan[];
  titleOf: (bookId: string) => string;
  busy: boolean;
  journalUnavailable: boolean;
  walletReady: boolean;
  demoMode?: boolean;
  renderSettlementDetails: (settlement: LibrarySettlement) => React.ReactNode;
  onConfirmReturn: (loan: LibraryLoan) => void;
  onSettleReturn: (loan: LibraryLoan) => void;
  onReportLost: (loan: LibraryLoan) => void;
}) {
  const activeLoansAll = useMemo(
    () =>
      loans
        .filter(l => !['RETURNED', 'LOST_SETTLED'].includes(l.status))
        .sort((a, b) => (ACTIVE_PRIORITY[a.status] ?? 9) - (ACTIVE_PRIORITY[b.status] ?? 9) || a.dueAt - b.dueAt),
    [loans],
  );
  const settledLoansAll = useMemo(
    () => loans.filter(l => ['RETURNED', 'LOST_SETTLED'].includes(l.status)),
    [loans],
  );

  const [activeFilter, setActiveFilter] = useState<'all' | 'SETTLEMENT_PENDING' | 'RETURN_REQUESTED' | 'ACTIVE' | 'LOST_SHORTFALL_DUE'>('all');
  const [activePage, setActivePage] = useState(1);
  const [activePageSize, setActivePageSize] = useState(5);

  const [historyFilter, setHistoryFilter] = useState<'all' | 'full-refund' | 'deducted' | 'lost'>('all');
  const [historyDensity, setHistoryDensity] = useState<'auto' | 'compact' | 'detailed'>('auto');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(6);

  const filteredActive = useMemo(
    () => activeLoansAll.filter(l => activeFilter === 'all' || l.status === activeFilter),
    [activeLoansAll, activeFilter],
  );

  const filteredSettled = useMemo(
    () =>
      settledLoansAll.filter(l => {
        if (historyFilter === 'all') return true;
        if (!l.settlement) return false;
        if (historyFilter === 'lost') return l.settlement.outcome === 'LOST';
        if (historyFilter === 'full-refund') {
          return l.settlement.outcome === 'RETURNED' && BigInt(l.settlement.totalRetainedWei) === BigInt(0);
        }
        if (historyFilter === 'deducted') {
          return l.settlement.outcome === 'RETURNED' && BigInt(l.settlement.totalRetainedWei) > BigInt(0);
        }
        return true;
      }),
    [settledLoansAll, historyFilter],
  );

  useEffect(() => { setActivePage(1); }, [activeFilter, activeLoansAll.length]);
  useEffect(() => { setHistoryPage(1); }, [historyFilter, settledLoansAll.length]);

  // Keep small datasets (<= 3 settled items) expanded by default for instant inspection & automated browser verification;
  // automatically switch to 1-line compact ledger rows as soon as history grows > 3 items!
  const isCompactLedger = historyDensity === 'compact' || (historyDensity === 'auto' && settledLoansAll.length > 3);

  const activeSize = activePageSize <= 0 ? Math.max(1, filteredActive.length) : activePageSize;
  const safeActivePage = Math.min(activePage, Math.max(1, Math.ceil(filteredActive.length / activeSize)));
  const pagedActive = filteredActive.slice((safeActivePage - 1) * activeSize, safeActivePage * activeSize);

  const historySize = historyPageSize <= 0 ? Math.max(1, filteredSettled.length) : historyPageSize;
  const safeHistoryPage = Math.min(historyPage, Math.max(1, Math.ceil(filteredSettled.length / historySize)));
  const pagedSettled = filteredSettled.slice((safeHistoryPage - 1) * historySize, safeHistoryPage * historySize);

  const actionDisabled = demoMode ? false : busy || journalUnavailable || !walletReady;

  return (
    <section className="surface-panel library-section" aria-label={demoMode ? 'Khoản mượn mẫu' : 'Khoản mượn'}>
      <span className="eyebrow">02 / Nhận sách & quyết toán{demoMode ? ' (Mẫu)' : ''}</span>
      <h2>Khoản mượn và sổ cái tiền cọc ({loans.length})</h2>

      {loans.length === 0 ? (
        <p>Không có khoản mượn phù hợp.</p>
      ) : (
        <div className="staff-loans-layers">
          {/* Tầng 2A: Các khoản đang hoạt động / cần thủ thư xử lý */}
          <div className="staff-active-layer">
            <div className="staff-section-top">
              <div>
                <h3 className="layer-heading">
                  Đang mở & cần xử lý ({activeLoansAll.length})
                </h3>
                <p className="muted-line">Đơn chờ quyết toán và đơn sinh viên vừa báo trả được ghim lên đầu tiên.</p>
              </div>
              {activeLoansAll.length > 1 ? (
                <div className="segmented-row" role="group" aria-label="Lọc khoản mượn đang mở">
                  {([
                    ['all', `Tất cả (${activeLoansAll.length})`],
                    ['SETTLEMENT_PENDING', `Chờ quyết toán (${activeLoansAll.filter(l => l.status === 'SETTLEMENT_PENDING').length})`],
                    ['RETURN_REQUESTED', `Báo trả (${activeLoansAll.filter(l => l.status === 'RETURN_REQUESTED').length})`],
                    ['ACTIVE', `Đang mượn (${activeLoansAll.filter(l => l.status === 'ACTIVE').length})`],
                    ['LOST_SHORTFALL_DUE', `Thiếu tiền mất (${activeLoansAll.filter(l => l.status === 'LOST_SHORTFALL_DUE').length})`],
                  ] as const)
                    .filter(([k]) => k === 'all' || activeLoansAll.some(l => l.status === k))
                    .map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        className={`seg-btn ${activeFilter === key ? 'active' : ''}`}
                        aria-pressed={activeFilter === key}
                        onClick={() => setActiveFilter(key)}
                      >
                        {label}
                      </button>
                    ))}
                </div>
              ) : null}
            </div>

            {filteredActive.length === 0 ? (
              <p className="muted-line">Không có khoản mượn đang mở trong nhóm lọc này.</p>
            ) : (
              <>
                <div className="library-list">
                  {pagedActive.map(l => {
                    const canConfirmOrLost = ['ACTIVE', 'RETURN_REQUESTED'].includes(l.status) && l.returnReceivedAt === null;
                    const canSettleReturn = l.status === 'SETTLEMENT_PENDING' && l.returnReceivedAt !== null;
                    return (
                      <article className="library-record staff-record" aria-label={`Khoản mượn ${l.loanId}`} key={l.loanId}>
                        <div className="staff-record-head">
                          <div className="staff-record-main">
                            <div className="staff-title-row">
                              <h3>{titleOf(l.bookId)}</h3>
                              <span className={`network-pill ${l.status === 'LOST_SHORTFALL_DUE' ? 'pill-danger' : 'pill-warning'}`}>
                                {libraryLabels[l.status] ?? 'Chưa xác minh'}
                              </span>
                            </div>
                            <div className="staff-meta-chips">
                              <span>Mã: <HashChip value={l.loanId} copyLabel="Sao chép mã khoản mượn" /></span>
                              <span>Người mượn: <HashChip value={l.borrower} copyLabel="Sao chép ví người mượn" /></span>
                            </div>
                          </div>
                          {canConfirmOrLost || canSettleReturn ? (
                            <div className="library-actions staff-actions-right">
                              {canConfirmOrLost ? (
                                <>
                                  <button type="button" className="secondary-btn" disabled={actionDisabled} onClick={() => onConfirmReturn(l)}>
                                    Xác nhận nhận sách
                                  </button>
                                  <button type="button" className="secondary-btn" disabled={actionDisabled} onClick={() => onReportLost(l)}>
                                    Báo mất
                                  </button>
                                </>
                              ) : null}
                              {canSettleReturn ? (
                                <button type="button" className="primary-cta-btn" disabled={actionDisabled} onClick={() => onSettleReturn(l)}>
                                  Quyết toán trả
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        <dl className="loan-timeline-grid">
                          <div><dt>Hạn trả</dt><dd className="tabular-value">{dateLabel(l.dueAt)}</dd></div>
                          <div><dt>Yêu cầu trả</dt><dd className="tabular-value">{dateLabel(l.returnRequestedAt)}</dd></div>
                          <div><dt>Nhận sách</dt><dd className="tabular-value">{dateLabel(l.returnReceivedAt)}</dd></div>
                        </dl>
                        {l.settlement ? renderSettlementDetails(l.settlement) : null}
                      </article>
                    );
                  })}
                </div>
                <PaginationBar
                  total={filteredActive.length}
                  page={safeActivePage}
                  pageSize={activePageSize}
                  onPage={setActivePage}
                  onPageSize={setActivePageSize}
                  sizes={[5, 10, 0]}
                  unitLabel="khoản đang mở"
                />
              </>
            )}
          </div>

          {/* Tầng 2B: Sổ cái lịch sử thanh toán cọc – nhận cọc đã tất toán */}
          {settledLoansAll.length > 0 ? (
            <div className="staff-history-ledger">
              <div className="staff-section-top">
                <div>
                  <h3 className="layer-heading">
                    Sổ cái lịch sử quyết toán cọc & hoàn cọc ({settledLoansAll.length})
                  </h3>
                  <p className="muted-line">
                    Các giao dịch đã hoàn tất được gom gọn dạng sao kê để dễ tra cứu khi có hàng chục/trăm lượt trả sách.
                  </p>
                </div>
                <div className="ledger-toolbar-controls">
                  <div className="segmented-row" role="group" aria-label="Lọc lịch sử quyết toán">
                    {([
                      ['all', `Tất cả (${settledLoansAll.length})`],
                      ['full-refund', 'Hoàn đủ 50 CAMPUS'],
                      ['deducted', 'Có khấu trừ phí'],
                      ['lost', 'Sách mất'],
                    ] as const).map(([key, label]) => (
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
                  <div className="segmented-row" role="group" aria-label="Mật độ hiển thị lịch sử">
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
                </div>
              </div>

              {filteredSettled.length === 0 ? (
                <p className="muted-line">Không có giao dịch lịch sử nào khớp bộ lọc này.</p>
              ) : (
                <>
                  <div className={isCompactLedger ? 'ledger-compact-list' : 'library-list'}>
                    {pagedSettled.map(l => {
                      const isRowExpanded = !isCompactLedger || Boolean(expandedIds[l.loanId]);
                      const badge = l.settlement ? cashflowBadge(l.settlement) : null;
                      const settledDate =
                        l.settlement?.outcome === 'RETURNED'
                          ? shortDate(l.settlement.returnedAt)
                          : shortDate(l.dueAt);

                      if (!isCompactLedger) {
                        return (
                          <article className="library-record staff-record" aria-label={`Khoản mượn ${l.loanId}`} key={l.loanId}>
                            <div className="staff-record-head">
                              <div className="staff-record-main">
                                <div className="staff-title-row">
                                  <h3>{titleOf(l.bookId)}</h3>
                                  <span className="network-pill pill-ok">{libraryLabels[l.status] ?? 'Đã tất toán'}</span>
                                </div>
                                <div className="staff-meta-chips">
                                  <span>Mã: <HashChip value={l.loanId} copyLabel="Sao chép mã khoản mượn" /></span>
                                  <span>Người mượn: <HashChip value={l.borrower} copyLabel="Sao chép ví người mượn" /></span>
                                </div>
                              </div>
                            </div>
                            <dl className="loan-timeline-grid">
                              <div><dt>Hạn trả</dt><dd className="tabular-value">{dateLabel(l.dueAt)}</dd></div>
                              <div><dt>Yêu cầu trả</dt><dd className="tabular-value">{dateLabel(l.returnRequestedAt)}</dd></div>
                              <div><dt>Nhận sách</dt><dd className="tabular-value">{dateLabel(l.returnReceivedAt)}</dd></div>
                            </dl>
                            {l.settlement ? renderSettlementDetails(l.settlement) : null}
                          </article>
                        );
                      }

                      return (
                        <article
                          className={`ledger-compact-row ${isRowExpanded ? 'ledger-row-expanded' : ''}`}
                          aria-label={`Khoản mượn ${l.loanId}`}
                          key={l.loanId}
                        >
                          <div className="ledger-row-summary">
                            <span className="ledger-date tabular-value">{settledDate}</span>
                            <div className="ledger-book-cell">
                              <strong>{titleOf(l.bookId)}</strong>
                              <span className="ledger-borrower-inline">
                                Người mượn: <code>{l.borrower.slice(0, 6)}…{l.borrower.slice(-4)}</code>
                              </span>
                            </div>
                            {badge ? (
                              <span className={`network-pill ledger-cash-pill ${badge.tone === 'ok' ? 'pill-ok' : badge.tone === 'danger' ? 'pill-danger' : 'pill-warning'}`}>
                                {badge.label}
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="hash-chip-btn ledger-toggle-btn"
                              aria-expanded={isRowExpanded}
                              onClick={() => setExpandedIds(prev => ({ ...prev, [l.loanId]: !prev[l.loanId] }))}
                            >
                              {isRowExpanded ? 'Ẩn chi tiết ▴' : 'Chi tiết ▾'}
                            </button>
                          </div>

                          {isRowExpanded ? (
                            <div className="ledger-row-details">
                              <div className="staff-meta-chips">
                                <span>Mã khoản mượn: <HashChip value={l.loanId} copyLabel="Sao chép mã khoản mượn" /></span>
                                <span>Ví người mượn: <HashChip value={l.borrower} copyLabel="Sao chép ví người mượn" /></span>
                              </div>
                              <dl className="loan-timeline-grid">
                                <div><dt>Hạn trả</dt><dd className="tabular-value">{dateLabel(l.dueAt)}</dd></div>
                                <div><dt>Yêu cầu trả</dt><dd className="tabular-value">{dateLabel(l.returnRequestedAt)}</dd></div>
                                <div><dt>Nhận sách</dt><dd className="tabular-value">{dateLabel(l.returnReceivedAt)}</dd></div>
                              </dl>
                              {l.settlement ? renderSettlementDetails(l.settlement) : null}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>

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

export function StaffCatalogInventory({ books }: { books: LibraryBook[] }) {
  const [stockFilter, setStockFilter] = useState<'all' | 'available' | 'out'>('all');
  const [sortBy, setSortBy] = useState<'title' | 'stock-asc' | 'price-desc'>('stock-asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(6);

  const processed = useMemo(() => {
    const filtered = books.filter(b => {
      if (stockFilter === 'available') return b.copiesAvailable > 0;
      if (stockFilter === 'out') return b.copiesAvailable === 0;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sortBy === 'stock-asc') return a.copiesAvailable - b.copiesAvailable || a.title.localeCompare(b.title, 'vi');
      if (sortBy === 'price-desc') {
        const diff = BigInt(b.replacementPriceWei) - BigInt(a.replacementPriceWei);
        return diff > BigInt(0) ? 1 : diff < BigInt(0) ? -1 : a.title.localeCompare(b.title, 'vi');
      }
      return a.title.localeCompare(b.title, 'vi');
    });
  }, [books, stockFilter, sortBy]);

  useEffect(() => { setPage(1); }, [stockFilter, sortBy, books.length]);

  const effectiveSize = pageSize <= 0 ? Math.max(1, processed.length) : pageSize;
  const safePage = Math.min(page, Math.max(1, Math.ceil(processed.length / effectiveSize)));
  const paged = processed.slice((safePage - 1) * effectiveSize, safePage * effectiveSize);
  const outCount = books.filter(b => b.copiesAvailable === 0).length;

  return (
    <section className="surface-panel library-section" aria-label="Kho sách thư viện">
      <div className="staff-section-top">
        <div>
          <span className="eyebrow"><Icon name="book" /> Danh mục & tồn kho</span>
          <h2>Kho sách thư viện ({books.length} đầu sách)</h2>
        </div>
        <div className="ledger-toolbar-controls">
          <div className="segmented-row" role="group" aria-label="Lọc tồn kho sách">
            <button type="button" className={`seg-btn ${stockFilter === 'all' ? 'active' : ''}`} aria-pressed={stockFilter === 'all'} onClick={() => setStockFilter('all')}>
              Tất cả ({books.length})
            </button>
            <button type="button" className={`seg-btn ${stockFilter === 'available' ? 'active' : ''}`} aria-pressed={stockFilter === 'available'} onClick={() => setStockFilter('available')}>
              Còn bản ({books.length - outCount})
            </button>
            <button type="button" className={`seg-btn ${stockFilter === 'out' ? 'active' : ''}`} aria-pressed={stockFilter === 'out'} onClick={() => setStockFilter('out')}>
              Hết bản ({outCount})
            </button>
          </div>
          <label className="pagination-size-picker">
            <span>Sắp xếp</span>
            <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}>
              <option value="stock-asc">Tồn kho thấp → cao</option>
              <option value="title">Tên sách A–Z</option>
              <option value="price-desc">Giá thay thế cao → thấp</option>
            </select>
          </label>
        </div>
      </div>

      {processed.length === 0 ? (
        <p className="muted-line">Không có đầu sách nào khớp bộ lọc hiện tại.</p>
      ) : (
        <>
          <div className="staff-inventory-grid">
            {paged.map(book => (
              <article key={book.bookId} className={`staff-book-card ${book.copiesAvailable === 0 ? 'book-out-of-stock' : ''}`}>
                <div className="book-card-header">
                  <BookCover book={book} />
                  <div className="book-card-meta">
                    <div className="staff-title-row">
                      <h3>{book.title}</h3>
                      <span className={`network-pill tabular-nums ${book.copiesAvailable === 0 ? 'pill-danger' : book.copiesAvailable === 1 ? 'pill-warning' : 'pill-ok'}`}>
                        {book.copiesAvailable === 0 ? `Hết bản (0/${book.copiesTotal})` : `Còn ${book.copiesAvailable}/${book.copiesTotal} bản`}
                      </span>
                    </div>
                    <p className="muted-line book-author-line">
                      <span>{book.author}</span>
                      {book.isbn ? <code className="mono-badge isbn-badge">ISBN {book.isbn}</code> : null}
                    </p>
                  </div>
                </div>
                <div className="staff-book-terms tabular-nums">
                  <span>Cọc: <strong>{moneyCompact(book.depositWei)}</strong></span>
                  <span>Giá thay thế: <strong>{moneyCompact(book.replacementPriceWei)}</strong></span>
                  <HashChip value={book.bookId} copyLabel={`Sao chép mã sách ${book.title}`} />
                </div>
              </article>
            ))}
          </div>
          <PaginationBar
            total={processed.length}
            page={safePage}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={setPageSize}
            sizes={[6, 12, 0]}
            unitLabel="đầu sách"
          />
        </>
      )}
    </section>
  );
}
