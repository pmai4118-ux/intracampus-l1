import { useState } from 'react';
import type { LibraryBook } from '@intracampus/network';
import { formatWalletBalance } from '../../../lib/chains';

export default function LibraryCatalog({ books, loading, blocked, busy, onSearch, onCreate }: {
  books: LibraryBook[]; loading: boolean; blocked: boolean; busy: boolean;
  onSearch(query: string): void; onCreate(book: LibraryBook): void;
}) {
  const [query, setQuery] = useState('');
  return <section className="surface-panel library-section" aria-labelledby="catalog-title" aria-busy={loading}>
    <div className="library-section-heading"><div><span className="eyebrow">01 / Chọn sách</span><h2 id="catalog-title">Danh mục thư viện</h2></div></div>
    <form className="library-search" onSubmit={event => { event.preventDefault(); onSearch(query); }}>
      <div><label className="field-label" htmlFor="library-search">Tên sách, tác giả hoặc ISBN</label>
        <input id="library-search" type="search" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <button className="secondary-btn" type="submit" disabled={busy || loading}>Tìm sách</button>
    </form>
    {loading ? <p role="status">Đang tìm sách…</p> : books.length === 0 ? <p role="status">Chưa có sách phù hợp. Thử từ khóa khác hoặc làm mới danh mục.</p> : null}
    {blocked ? <p className="wallet-warning">Chưa thể mượn mới. Kiểm tra trạng thái ví, đăng nhập hoặc xử lý khoản mượn đang giữ tài khoản bên dưới.</p> : null}
    <ul className="library-list">{books.map(book => <li key={book.bookId} className="library-book">
      <div><h3>{book.title}</h3><p>{book.author}{book.isbn ? ` · ISBN ${book.isbn}` : ''}</p>
        <span className="network-pill">Còn {book.copiesAvailable}/{book.copiesTotal} bản</span></div>
      <dl className="price-breakdown"><div className="price-row"><dt>Tiền cọc</dt><dd>{formatWalletBalance(BigInt(book.depositWei))}</dd></div>
        <div className="price-row"><dt>Giá thay thế</dt><dd>{formatWalletBalance(BigInt(book.replacementPriceWei))}</dd></div></dl>
      <button type="button" className="primary-cta-btn" disabled={blocked || busy || loading || book.copiesAvailable === 0} onClick={() => onCreate(book)}>
        {book.copiesAvailable === 0 ? 'Hiện hết bản' : `Tạo yêu cầu: ${book.title}`}</button>
      <p className="metric-note">Chưa giữ bản khi tạo yêu cầu. Chỉ gán bản sau khi cọc đã được xác minh.</p>
    </li>)}</ul>
  </section>;
}
