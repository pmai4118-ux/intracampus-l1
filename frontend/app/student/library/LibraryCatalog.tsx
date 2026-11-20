import { useEffect, useMemo, useState } from 'react';
import type { LibraryBook } from '@intracampus/network';
import { formatWalletBalance } from '../../../lib/chains';
import BookCover from '../../components/BookCover';
import PaginationBar from '../../components/PaginationBar';

export default function LibraryCatalog({
  books,
  loading,
  blocked,
  busy,
  onSearch,
  onCreate,
}: {
  books: LibraryBook[];
  loading: boolean;
  blocked: boolean;
  busy: boolean;
  onSearch(query: string): void;
  onCreate(book: LibraryBook): void;
}) {
  const [query, setQuery] = useState('');
  const [stockFilter, setStockFilter] = useState<'all' | 'available' | 'out'>('all');
  const [sortBy, setSortBy] = useState<'default' | 'stock-desc' | 'title'>('default');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(6);

  const processedBooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = books.filter(book => {
      if (stockFilter === 'available' && book.copiesAvailable === 0) return false;
      if (stockFilter === 'out' && book.copiesAvailable > 0) return false;
      if (!q) return true;
      return (
        book.title.toLowerCase().includes(q) ||
        book.author.toLowerCase().includes(q) ||
        (book.isbn ?? '').toLowerCase().includes(q)
      );
    });
    if (sortBy === 'default') return filtered;
    return [...filtered].sort((a, b) => {
      if (sortBy === 'stock-desc') return b.copiesAvailable - a.copiesAvailable || a.title.localeCompare(b.title, 'vi');
      return a.title.localeCompare(b.title, 'vi');
    });
  }, [books, query, stockFilter, sortBy]);

  useEffect(() => {
    setPage(1);
  }, [query, stockFilter, sortBy, books.length]);

  const effectiveSize = pageSize <= 0 ? Math.max(1, processedBooks.length) : pageSize;
  const safePage = Math.min(page, Math.max(1, Math.ceil(processedBooks.length / effectiveSize)));
  const pagedBooks = processedBooks.slice((safePage - 1) * effectiveSize, safePage * effectiveSize);
  const outCount = books.filter(b => b.copiesAvailable === 0).length;

  return (
    <section className="surface-panel library-section" aria-labelledby="catalog-title" aria-busy={loading}>
      <div className="staff-section-top">
        <div>
          <span className="eyebrow">01 / Chọn sách</span>
          <h2 id="catalog-title">Danh mục thư viện ({books.length})</h2>
        </div>
        {books.length > 0 ? (
          <div className="ledger-toolbar-controls">
            <div className="segmented-row" role="group" aria-label="Lọc tình trạng bản sách">
              <button
                type="button"
                className={`seg-btn ${stockFilter === 'all' ? 'active' : ''}`}
                aria-pressed={stockFilter === 'all'}
                onClick={() => setStockFilter('all')}
              >
                Tất cả ({books.length})
              </button>
              <button
                type="button"
                className={`seg-btn ${stockFilter === 'available' ? 'active' : ''}`}
                aria-pressed={stockFilter === 'available'}
                onClick={() => setStockFilter('available')}
              >
                Còn bản ({books.length - outCount})
              </button>
              {outCount > 0 ? (
                <button
                  type="button"
                  className={`seg-btn ${stockFilter === 'out' ? 'active' : ''}`}
                  aria-pressed={stockFilter === 'out'}
                  onClick={() => setStockFilter('out')}
                >
                  Hết bản ({outCount})
                </button>
              ) : null}
            </div>
            <label className="pagination-size-picker">
              <span>Sắp xếp</span>
              <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}>
                <option value="default">Mặc định</option>
                <option value="stock-desc">Còn nhiều bản trước</option>
                <option value="title">Tên sách A–Z</option>
              </select>
            </label>
          </div>
        ) : null}
      </div>

      <form
        className="library-search"
        onSubmit={event => {
          event.preventDefault();
          onSearch(query);
        }}
      >
        <div>
          <label className="field-label" htmlFor="library-search">
            Tên sách, tác giả hoặc ISBN
          </label>
          <input
            id="library-search"
            type="search"
            placeholder="Nhập từ khóa để lọc nhanh hoặc bấm Tìm sách…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <button className="secondary-btn" type="submit" disabled={busy || loading}>
          Tìm sách
        </button>
      </form>

      {loading ? (
        <p role="status">Đang tìm sách…</p>
      ) : processedBooks.length === 0 ? (
        <p role="status">Chưa có sách phù hợp. Thử từ khóa khác hoặc làm mới danh mục.</p>
      ) : null}
      {blocked ? (
        <p className="wallet-warning">
          Chưa thể mượn mới. Kiểm tra trạng thái ví, đăng nhập hoặc xử lý khoản mượn đang giữ tài khoản bên dưới.
        </p>
      ) : null}

      <ul className="library-list student-catalog-grid">
        {pagedBooks.map(book => (
          <li key={book.bookId} className={`library-book ${book.copiesAvailable === 0 ? 'book-out-of-stock' : ''}`}>
            <div className="book-card-header">
              <BookCover book={book} />
              <div className="book-card-meta">
                <div className="staff-title-row">
                  <h3>{book.title}</h3>
                  <span className={`network-pill tabular-nums ${book.copiesAvailable === 0 ? 'pill-danger' : book.copiesAvailable === 1 ? 'pill-warning' : 'pill-ok'}`}>
                    Còn {book.copiesAvailable}/{book.copiesTotal} bản
                  </span>
                </div>
                <p className="muted-line book-author-line">
                  <span>{book.author}</span>
                  {book.isbn ? <code className="mono-badge isbn-badge">ISBN {book.isbn}</code> : null}
                </p>
              </div>
            </div>
            <dl className="price-breakdown">
              <div className="price-row">
                <dt>Tiền cọc</dt>
                <dd className="tabular-value">{formatWalletBalance(BigInt(book.depositWei))}</dd>
              </div>
              <div className="price-row">
                <dt>Giá thay thế</dt>
                <dd className="tabular-value">{formatWalletBalance(BigInt(book.replacementPriceWei))}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="primary-cta-btn"
              aria-label={book.copiesAvailable === 0 ? 'Hiện hết bản' : `Tạo yêu cầu: ${book.title}`}
              disabled={blocked || busy || loading || book.copiesAvailable === 0}
              onClick={() => onCreate(book)}
            >
              {book.copiesAvailable === 0 ? 'Hiện hết bản' : 'Tạo yêu cầu mượn'}
            </button>
            <p className="metric-note">Chưa giữ bản khi tạo yêu cầu. Chỉ gán bản sau khi cọc đã được xác minh.</p>
          </li>
        ))}
      </ul>

      <PaginationBar
        total={processedBooks.length}
        page={safePage}
        pageSize={pageSize}
        onPage={setPage}
        onPageSize={setPageSize}
        sizes={[6, 12, 0]}
        unitLabel="đầu sách"
      />
    </section>
  );
}
