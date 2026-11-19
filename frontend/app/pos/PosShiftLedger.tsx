'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatWalletBalance, formatWalletBalanceCompact } from '../../lib/chains';
import type { PosSessionLedgerEntry } from '../demo-fixtures';
import HashChip from '../components/HashChip';
import Icon from '../components/Icon';
import PaginationBar from '../components/PaginationBar';

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

export default function PosShiftLedger({
  entries,
  activeInvoiceId,
  demoMode = false,
  busy = false,
  onSelectInvoice,
  onClearHistory,
}: {
  entries: PosSessionLedgerEntry[];
  activeInvoiceId: string | null;
  demoMode?: boolean;
  busy?: boolean;
  onSelectInvoice?: (invoiceId: string) => void;
  onClearHistory?: () => void;
}) {
  const [filter, setFilter] = useState<'all' | 'paid' | 'open'>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);

  const stats = useMemo(() => {
    const paidEntries = entries.filter(e => e.status === 'paid');
    const collectedWei = paidEntries.reduce(
      (sum, e) => sum + BigInt(e.paidAmountWei ?? e.amountWei),
      BigInt(0),
    );
    const sbtCount = paidEntries.filter(e => e.tier === 1).length;
    const openCount = entries.length - paidEntries.length;
    return {
      paidCount: paidEntries.length,
      collectedWei,
      sbtCount,
      openCount,
    };
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(e => {
      if (filter === 'paid' && e.status !== 'paid') return false;
      if (filter === 'open' && e.status === 'paid') return false;
      if (!q) return true;
      return (
        e.invoiceCode.toLowerCase().includes(q) ||
        e.invoiceId.toLowerCase().includes(q) ||
        e.serviceName.toLowerCase().includes(q)
      );
    });
  }, [entries, filter, query]);

  useEffect(() => {
    setPage(1);
  }, [filter, query, entries.length]);

  if (entries.length === 0) return null;

  const effectiveSize = pageSize <= 0 ? Math.max(1, filtered.length) : pageSize;
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / effectiveSize)));
  const paged = filtered.slice((safePage - 1) * effectiveSize, safePage * effectiveSize);

  return (
    <section
      className="surface-panel pos-shift-ledger"
      aria-label={demoMode ? 'Sổ cái ca trực mẫu' : 'Sổ cái hóa đơn trong phiên'}
    >
      <div className="staff-section-top">
        <div className="panel-heading-with-icon">
          <span className="panel-icon">
            <Icon name="clock" />
          </span>
          <div>
            <span className="panel-eyebrow">
              {demoMode ? 'CA TRỰC MINH HỌA · DỮ LIỆU MẪU' : '03 · NHẬT KÝ PHIÊN TRỰC TRÊN TRÌNH DUYỆT'}
            </span>
            <h2>Hóa đơn phát hành gần đây ({entries.length})</h2>
          </div>
        </div>
        <div className="ledger-toolbar-controls">
          <div className="segmented-row" role="group" aria-label="Lọc sổ cái POS">
            <button
              type="button"
              className={`seg-btn ${filter === 'all' ? 'active' : ''}`}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              Tất cả ({entries.length})
            </button>
            <button
              type="button"
              className={`seg-btn ${filter === 'paid' ? 'active' : ''}`}
              aria-pressed={filter === 'paid'}
              onClick={() => setFilter('paid')}
            >
              Đã thu ({stats.paidCount})
            </button>
            <button
              type="button"
              className={`seg-btn ${filter === 'open' ? 'active' : ''}`}
              aria-pressed={filter === 'open'}
              onClick={() => setFilter('open')}
            >
              Chờ thu / hết hạn ({stats.openCount})
            </button>
          </div>
          {entries.length > 2 ? (
            <div className="canteen-inline-search">
              <label htmlFor={demoMode ? 'pos-demo-ledger-search' : 'pos-live-ledger-search'} className="sr-only">
                Tìm theo mã phiếu hoặc invoiceId
              </label>
              <input
                id={demoMode ? 'pos-demo-ledger-search' : 'pos-live-ledger-search'}
                type="search"
                placeholder="Tìm mã phiếu PK-…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>
          ) : null}
          {onClearHistory ? (
            <button type="button" className="text-action-btn" onClick={onClearHistory}>
              Xóa nhật ký phiên
            </button>
          ) : null}
        </div>
      </div>

      <dl className="library-policy-strip pos-shift-stats">
        <div className="policy-stat-chip">
          <dt>Tổng lượt phát hành</dt>
          <dd>
            <strong className="tabular-value">{entries.length} phiếu</strong>
          </dd>
        </div>
        <div className="policy-stat-chip">
          <dt>Đã xác minh thu tiền</dt>
          <dd>
            <strong className="tabular-value">{stats.paidCount} lượt</strong> ({stats.sbtCount} thẻ SBT)
          </dd>
        </div>
        <div className="policy-stat-chip">
          <dt>Thực thu trong phiên</dt>
          <dd>
            <strong className="tabular-value">
              {formatWalletBalanceCompact(stats.collectedWei, 2).display}
            </strong>
          </dd>
        </div>
        <div className="policy-stat-chip">
          <dt>Chưa thu / hết hạn</dt>
          <dd>
            <strong className="tabular-value">{stats.openCount} phiếu</strong>
          </dd>
        </div>
      </dl>

      {filtered.length === 0 ? (
        <p className="muted-line">Không có phiếu nào khớp bộ lọc hiện tại.</p>
      ) : (
        <>
          <div className="ledger-compact-list">
            {paged.map(entry => {
              const isSelected = Boolean(
                activeInvoiceId && activeInvoiceId.toLowerCase() === entry.invoiceId.toLowerCase(),
              );
              const displayWei = entry.status === 'paid' && entry.paidAmountWei ? entry.paidAmountWei : entry.amountWei;
              return (
                <article
                  key={entry.invoiceId}
                  className={`ledger-compact-row ${isSelected ? 'ledger-row-selected' : ''}`}
                >
                  <div className="ledger-row-summary canteen-ledger-row">
                    <span className="ledger-date tabular-value">{timeLabel(entry.createdAt)}</span>
                    <div className="ledger-book-cell">
                      <strong>{entry.invoiceCode} · {entry.serviceName}</strong>
                      <HashChip value={entry.invoiceId} copyLabel={`Sao chép invoiceId ${entry.invoiceCode}`} />
                    </div>
                    <span className="canteen-ledger-amount tabular-value">
                      {entry.status === 'paid' ? 'Đã thu ' : 'Niêm yết '}
                      <strong>{formatWalletBalance(BigInt(displayWei))}</strong>
                      {entry.status === 'paid' && entry.tier === 1 ? (
                        <small className="ledger-discount-tag">-10% SBT</small>
                      ) : null}
                    </span>
                    <span
                      className={`network-pill ledger-cash-pill ${
                        entry.status === 'paid'
                          ? 'pill-ok'
                          : entry.status === 'expired'
                            ? 'pill-danger'
                            : 'pill-warning'
                      }`}
                    >
                      {entry.status === 'paid'
                        ? 'Đã xác minh'
                        : entry.status === 'expired'
                          ? 'Hết hạn'
                          : 'Chờ thanh toán'}
                    </span>
                    {onSelectInvoice ? (
                      <button
                        type="button"
                        className={`hash-chip-btn ledger-toggle-btn ${isSelected ? 'chip-active' : ''}`}
                        disabled={busy || isSelected}
                        onClick={() => onSelectInvoice(entry.invoiceId)}
                      >
                        {isSelected ? 'Đang theo dõi' : 'Theo dõi lại →'}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
          <PaginationBar
            total={filtered.length}
            page={safePage}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={setPageSize}
            sizes={[5, 10, 0]}
            unitLabel="hóa đơn"
          />
        </>
      )}
    </section>
  );
}
