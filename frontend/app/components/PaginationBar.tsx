'use client';

export default function PaginationBar({
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
  sizes = [6, 12, 0],
  unitLabel = 'mục',
}: {
  total: number;
  page: number;
  pageSize: number;
  onPage: (next: number) => void;
  onPageSize?: (size: number) => void;
  sizes?: number[];
  unitLabel?: string;
}) {
  const effectiveSize = pageSize <= 0 ? Math.max(1, total) : pageSize;
  const totalPages = Math.max(1, Math.ceil(total / effectiveSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  if (total <= sizes[0] && safePage === 1) return null;
  const start = total === 0 ? 0 : (safePage - 1) * effectiveSize + 1;
  const end = Math.min(total, safePage * effectiveSize);

  return (
    <div className="staff-pagination-bar" role="navigation" aria-label={`Phân trang ${unitLabel}`}>
      <span className="pagination-summary tabular-value">
        Hiển thị <strong>{start}–{end}</strong> / {total} {unitLabel}
      </span>
      <div className="pagination-controls">
        {onPageSize ? (
          <label className="pagination-size-picker">
            <span>Mỗi trang</span>
            <select
              value={pageSize}
              onChange={e => {
                onPageSize(Number(e.target.value));
                onPage(1);
              }}
            >
              {sizes.map(s => (
                <option key={s} value={s}>
                  {s === 0 ? 'Tất cả' : `${s} dòng`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {totalPages > 1 ? (
          <div className="pagination-buttons">
            <button
              type="button"
              className="secondary-btn pagination-btn"
              disabled={safePage <= 1}
              onClick={() => onPage(safePage - 1)}
            >
              ← Trước
            </button>
            <span className="pagination-page-indicator tabular-value">
              Trang {safePage} / {totalPages}
            </span>
            <button
              type="button"
              className="secondary-btn pagination-btn"
              disabled={safePage >= totalPages}
              onClick={() => onPage(safePage + 1)}
            >
              Sau →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
