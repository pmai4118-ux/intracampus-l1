'use client';
import { CAMPUS_CHAIN_ID } from "@intracampus/network";

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanteenDish, CanteenOrder } from '@intracampus/network';
import { WalletSession, useCampusWallet } from '../WalletPanel';
import LibraryWalletSummary from '../library/LibraryWalletSummary';
import { signInLibraryStudent } from '../../../lib/library-session';
import { browserWalletConfig, formatWalletBalance } from '../../../lib/chains';
import { createWalletRpc } from '../../../lib/wallet';
import { verifyInvoicePreview } from '../../../lib/invoice';
import type { InvoicePreview } from '../../../lib/payment';
import { PayInvoice } from '../PayInvoice';
import CanteenFood from './CanteenFood';
import PageHeading from '../../components/PageHeading';
import Icon from '../../components/Icon';
import DishArtwork from '../../components/DishArtwork';
import HashChip from '../../components/HashChip';
import PaginationBar from '../../components/PaginationBar';
import { demoCanteenDishes, demoCanteenOrders, type CanteenDishCategory } from '../../demo-fixtures';

const dishMetaById = new Map(demoCanteenDishes.map(item => [item.id, item]));

function formatOrderTime(ts: number): string {
  const ms = ts < 1e11 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function summarizeOrderItems(order: CanteenOrder): string {
  if (!order.items.length) return 'Đơn nhà ăn';
  const [first, ...rest] = order.items;
  const lead = `${first.name} ×${first.quantity}`;
  return rest.length > 0 ? `${lead} (+${rest.length} món)` : lead;
}

async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/canteen/${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.code ?? 'SERVICE_UNAVAILABLE');
  return data;
}

const labels: Record<string, string> = {
  RPC_UNAVAILABLE: 'Chưa kết nối được mạng. Giữ hash cũ và thử đối chiếu lại.',
  SERVICE_UNAVAILABLE: 'Chưa đọc được dịch vụ nhà ăn. Thử lại sau.',
  WRONG_CHAIN: `Chuyển ví sang IntraCampus L1, chain ${CAMPUS_CHAIN_ID}.`,
  DISH_UNAVAILABLE: 'Món đã chọn hiện không có trong thực đơn. Hãy tải lại thực đơn.',
  FORBIDDEN: 'Ví đang kết nối là tài khoản Thủ thư hoặc chưa đăng ký sinh viên. Hãy đổi sang ví sinh viên trong Core hoặc mở Xem bản minh họa.',
  IDEMPOTENCY_CONFLICT: 'Lượt tạo đơn cũ có nội dung khác. Khôi phục đơn chưa rõ kết quả trước.',
  INVOICE_EXPIRED: 'Hóa đơn đã hết hạn. Giữ đơn cũ trong lịch sử và tạo đơn mới; không gửi lại giao dịch chưa rõ kết quả.',
  INVOICE_ALREADY_PAID: 'Hóa đơn đã trả trên chain. Mở lại đơn để đối chiếu; không trả thêm.',
  UNAUTHENTICATED: 'Cần xác thực chữ ký ví sinh viên để tạo đơn.',
  ACCOUNT_HELD: 'Tài khoản đang bị giữ. Xử lý khoản mượn thư viện trước khi đặt món.',
  INSUFFICIENT_FOOD: 'Học bổng FOOD không đủ cho đơn này.',
  STALE_CHAIN_STATE: 'Mạng chưa có block mới. Thử lại khi RPC hoạt động.',
  CONFIGURATION_ERROR: 'Chưa cấu hình mạng và căn-tin.',
  RECEIPT_MISMATCH: 'Giao dịch không khớp đơn. Giữ hash để đối chiếu.',
  PAYMENT_ALREADY_USED: 'Giao dịch này đã gắn với đơn khác.',
};

export default function CanteenSession() {
  return (
    <WalletSession>
      <Canteen />
    </WalletSession>
  );
}

function Canteen() {
  const { state: wallet, controller, access, refreshAccess } = useCampusWallet();
  const [mode, setMode] = useState<'live' | 'demo'>('live');
  return (
    <div className="library-shell canteen-shell">
      <PageHeading
        eyebrow="BỮA NGON GIỮA NGÀY"
        title="Hẹn nhau ở nhà ăn."
        description="Chọn món hôm nay, thanh toán bằng CAMPUS hoặc học bổng FOOD."
        icon="utensils"
      >
        <div className="mode-switch-wrapper">
          <span className="mode-switch-kicker">
            <span className={`mode-status-dot ${mode === 'live' ? 'dot-live' : 'dot-demo'}`} aria-hidden="true" />
            {mode === 'live' ? `Avalanche L1 · Chain ${CAMPUS_CHAIN_ID}` : 'Bản minh họa'}
          </span>
          <div className="student-mode-switch" role="group" aria-label="Chế độ nhà ăn">
            <button type="button" className="secondary-btn" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>
              Nhà ăn thật
            </button>
            <button type="button" className="secondary-btn" aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}>
              Xem bản minh họa
            </button>
          </div>
        </div>
        <Link className="secondary-btn" href="/staff/canteen">
          Quầy cô nhà ăn
        </Link>
        <Link className="secondary-btn heading-mobile-hide" href="/student">
          Về ví sinh viên
        </Link>
      </PageHeading>
      {mode === 'live' ? (
        <>
          <LibraryWalletSummary />
          <Workspace
            key={`${wallet.address}:${wallet.chainId}`}
            wallet={wallet.address}
            tier={wallet.card.tier}
            initialSigned={access?.status === 'ready' || access?.status === 'held'}
            onSigned={() => void refreshAccess()}
            onConnect={() => void controller.connect()}
            onOpenDemo={() => setMode('demo')}
            sign={(account, message) => controller.signMessage(account, message)}
          />
        </>
      ) : (
        <CanteenDemoWorkspace onBackToLive={() => setMode('live')} />
      )}
    </div>
  );
}

function CanteenOrderHistoryLedger({
  orders,
  activeOrderId,
  busy = false,
  demoMode = false,
  emptyText,
  onSelectOrder,
}: {
  orders: CanteenOrder[];
  activeOrderId: string | null;
  busy?: boolean;
  demoMode?: boolean;
  emptyText: string;
  onSelectOrder: (order: CanteenOrder) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<'all' | 'AWAITING_PAYMENT' | 'PAID' | 'EXPIRED'>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(5);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter(order => {
      if (statusFilter !== 'all' && order.status !== statusFilter) return false;
      if (!q) return true;
      return (
        order.id.toLowerCase().includes(q) ||
        (order.txHash ?? '').toLowerCase().includes(q) ||
        order.items.some(item => item.name.toLowerCase().includes(q))
      );
    });
  }, [orders, statusFilter, query]);

  useEffect(() => {
    setPage(1);
  }, [statusFilter, query, orders.length]);

  const effectiveSize = pageSize <= 0 ? Math.max(1, filtered.length) : pageSize;
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / effectiveSize)));
  const paged = filtered.slice((safePage - 1) * effectiveSize, safePage * effectiveSize);

  return (
    <section className="surface-panel canteen-history">
      <div className="staff-section-top">
        <div className="panel-heading-with-icon">
          <span className="panel-icon">
            <Icon name="clock" />
          </span>
          <div>
            <span className="panel-eyebrow">{demoMode ? 'NHỮNG BỮA ĂN MẪU' : 'NHỮNG BỮA ĂN ĐÃ ĐẶT'}</span>
            <h2>
              Lịch sử đơn{orders.length > 0 ? ` (${orders.length})` : ''}
            </h2>
          </div>
        </div>
        {orders.length > 0 ? (
          <div className="ledger-toolbar-controls">
            <div className="segmented-row" role="group" aria-label="Lọc trạng thái đơn nhà ăn">
              {(
                [
                  ['all', `Tất cả (${orders.length})`],
                  ['AWAITING_PAYMENT', `Chờ trả (${orders.filter(o => o.status === 'AWAITING_PAYMENT').length})`],
                  ['PAID', `Đã thanh toán (${orders.filter(o => o.status === 'PAID').length})`],
                  ['EXPIRED', `Hết hạn (${orders.filter(o => o.status === 'EXPIRED').length})`],
                ] as const
              )
                .filter(([k]) => k === 'all' || orders.some(o => o.status === k))
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`seg-btn ${statusFilter === key ? 'active' : ''}`}
                    aria-pressed={statusFilter === key}
                    onClick={() => setStatusFilter(key)}
                  >
                    {label}
                  </button>
                ))}
            </div>
            {orders.length > 2 ? (
              <div className="canteen-inline-search">
                <label htmlFor={demoMode ? 'demo-order-search' : 'live-order-search'} className="sr-only">
                  Tìm theo mã đơn hoặc tên món ăn
                </label>
                <input
                  id={demoMode ? 'demo-order-search' : 'live-order-search'}
                  type="search"
                  placeholder="Tìm mã đơn / món ăn…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {orders.length === 0 ? (
        <p>{emptyText}</p>
      ) : filtered.length === 0 ? (
        <p className="muted-line">Không có đơn ăn nào khớp bộ lọc hiện tại.</p>
      ) : (
        <>
          <div className="ledger-compact-list">
            {paged.map(o => {
              const isSelected = activeOrderId === o.id;
              const shownAmountWei = o.status === 'PAID' && o.paidAmountWei ? o.paidAmountWei : o.totalWei;
              const hasDiscount =
                o.status === 'PAID' && o.paidAmountWei !== null && BigInt(o.paidAmountWei) < BigInt(o.totalWei);
              return (
                <article
                  key={o.id}
                  className={`ledger-compact-row ${isSelected ? 'ledger-row-selected' : ''}`}
                >
                  <div className="ledger-row-summary canteen-ledger-row">
                    <span className="ledger-date tabular-value">{formatOrderTime(o.createdAt)}</span>
                    <div className="ledger-book-cell">
                      <strong>#{o.id.slice(0, 8)} · {summarizeOrderItems(o)}</strong>
                      <span className="ledger-borrower-inline">
                        {o.method === 'FOOD' ? 'Học bổng FOOD' : 'Ví CAMPUS'}
                      </span>
                    </div>
                    <span className="canteen-ledger-amount tabular-value">
                      {o.status === 'PAID' ? 'Đã trả ' : ''}
                      <strong>{formatWalletBalance(BigInt(shownAmountWei))}</strong>
                      {hasDiscount ? <small className="ledger-discount-tag">-10% SBT</small> : null}
                    </span>
                    <span
                      className={`network-pill ledger-cash-pill ${o.status === 'PAID' ? 'pill-ok' : o.status === 'EXPIRED' ? 'pill-danger' : 'pill-warning'
                        }`}
                    >
                      {o.status === 'PAID' ? 'Đã thanh toán' : o.status === 'EXPIRED' ? 'Hết hạn' : 'Chờ thanh toán'}
                    </span>
                    <button
                      type="button"
                      className={`hash-chip-btn ledger-toggle-btn ${isSelected ? 'chip-active' : ''}`}
                      disabled={busy}
                      onClick={() => onSelectOrder(o)}
                    >
                      {isSelected ? 'Đang xem' : 'Xem đơn →'}
                    </button>
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
            unitLabel="đơn ăn"
          />
        </>
      )}
    </section>
  );
}

function ActiveOrderDetailsSummary({ order }: { order: CanteenOrder }) {
  const totalWei = BigInt(order.totalWei);
  const paidWei = order.paidAmountWei ? BigInt(order.paidAmountWei) : null;
  const savedWei = paidWei !== null && paidWei < totalWei ? totalWei - paidWei : BigInt(0);

  return (
    <>
      <div className="staff-meta-chips canteen-order-meta">
        <span>Đặt lúc: <strong className="tabular-value">{formatOrderTime(order.createdAt)}</strong></span>
        {order.invoiceId ? (
          <span>Mã hóa đơn: <HashChip value={order.invoiceId} copyLabel="Sao chép mã hóa đơn" /></span>
        ) : null}
        {order.txHash ? (
          <span>Mã giao dịch: <HashChip value={order.txHash} start={10} end={8} copyLabel="Sao chép mã giao dịch đơn ăn" /></span>
        ) : null}
      </div>

      <ul className="canteen-order-items-table">
        {order.items.map(i => (
          <li key={i.dishId}>
            <span>
              <strong>{i.name}</strong> <span className="muted-inline">× {i.quantity}</span>
            </span>
            <strong className="tabular-value">{formatWalletBalance(BigInt(i.unitPriceWei) * BigInt(i.quantity))}</strong>
          </li>
        ))}
      </ul>

      {order.status === 'PAID' && paidWei !== null ? (
        <dl className="settlement-summary-highlight canteen-paid-summary">
          <div className="summary-retained-box">
            <dt>Tổng giá niêm yết</dt>
            <dd className="tabular-value">{formatWalletBalance(totalWei)}</dd>
          </div>
          {savedWei > BigInt(0) ? (
            <div className="summary-refund-box">
              <dt>Ưu đãi thẻ SBT (-10%)</dt>
              <dd className="tabular-value">-{formatWalletBalance(savedWei)}</dd>
            </div>
          ) : null}
          <div className="summary-refund-box">
            <dt>Đã trả (đã xác minh)</dt>
            <dd className="tabular-value">{formatWalletBalance(paidWei)}</dd>
          </div>
        </dl>
      ) : null}
    </>
  );
}

function Workspace({
  wallet,
  tier,
  initialSigned,
  onSigned,
  onConnect,
  onOpenDemo,
  sign,
}: {
  wallet: string | null;
  tier: number | null;
  initialSigned: boolean;
  onSigned: () => void;
  onConnect: () => void;
  onOpenDemo: () => void;
  sign: (account: string, message: string) => Promise<string>;
}) {
  const [dishes, setDishes] = useState<CanteenDish[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [orders, setOrders] = useState<CanteenOrder[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<'all' | CanteenDishCategory>('all');
  const [dishSearch, setDishSearch] = useState('');
  const [menuPage, setMenuPage] = useState(1);
  const [menuPageSize, setMenuPageSize] = useState(6);
  const [usingFallbackMenu, setUsingFallbackMenu] = useState(false);
  const [method, setMethod] = useState<'WALLET' | 'FOOD'>('WALLET');
  const [active, setActive] = useState<CanteenOrder | null>(null);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signed, setSigned] = useState(initialSigned);
  const activeOrderId = useRef<string | null>(null);
  const activeOrderRef = useRef<HTMLElement | null>(null);
  const [pendingCreate, setPendingCreate] = useState(false);
  const [menuLoading, setMenuLoading] = useState(true);
  const [menuError, setMenuError] = useState(false);
  const [menuVersion, setMenuVersion] = useState(0);

  useEffect(() => {
    try {
      setPendingCreate(!!localStorage.getItem(`intracampus.canteen.create:${wallet}`));
    } catch {
      setError('Không đọc được bộ nhớ đơn hàng.');
    }
  }, [wallet]);

  useEffect(() => {
    if (!wallet || !initialSigned) return;
    let live = true;
    setSigned(true);
    void api('orders')
      .then(data => {
        if (live) setOrders(data.orders);
      })
      .catch(() => { });
    return () => {
      live = false;
    };
  }, [wallet, initialSigned]);

  useEffect(() => {
    if (active) activeOrderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [active?.id]);

  const total = dishes.reduce((n, d) => n + BigInt(d.priceWei) * BigInt(cart[d.id] ?? 0), BigInt(0));
  const selectedDishes = dishes.filter(dish => (cart[dish.id] ?? 0) > 0);
  const totalPortions = selectedDishes.reduce((sum, dish) => sum + (cart[dish.id] ?? 0), 0);

  const visibleDishes = useMemo(() => {
    const q = dishSearch.trim().toLowerCase();
    return dishes.filter(dish => {
      if (categoryFilter !== 'all') {
        const cat = dishMetaById.get(dish.id)?.category ?? 'main';
        if (cat !== categoryFilter) return false;
      }
      if (!q) return true;
      return dish.name.toLowerCase().includes(q) || dish.description.toLowerCase().includes(q);
    });
  }, [dishes, categoryFilter, dishSearch]);

  useEffect(() => {
    setMenuPage(1);
  }, [categoryFilter, dishSearch]);

  const effectiveMenuSize = menuPageSize <= 0 ? Math.max(1, visibleDishes.length) : menuPageSize;
  const safeMenuPage = Math.min(menuPage, Math.max(1, Math.ceil(visibleDishes.length / effectiveMenuSize)));
  const pagedDishes = visibleDishes.slice((safeMenuPage - 1) * effectiveMenuSize, safeMenuPage * effectiveMenuSize);

  const cartRef = useRef<HTMLElement | null>(null);

  function setQuantity(id: string, quantity: number) {
    if (Number.isSafeInteger(quantity) && quantity >= 0) setCart(previous => ({ ...previous, [id]: quantity }));
  }

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      const code = e instanceof Error ? e.message : 'SERVICE_UNAVAILABLE';
      setError(labels[code] ?? code);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let live = true;
    setMenuLoading(true);
    setMenuError(false);
    setUsingFallbackMenu(false);
    void api('menu')
      .then(data => {
        if (!live) return;
        if (Array.isArray(data.dishes) && data.dishes.length > 0) {
          setDishes(data.dishes);
        } else {
          setDishes(demoCanteenDishes);
          setUsingFallbackMenu(true);
        }
      })
      .catch(() => {
        if (!live) return;
        setDishes(demoCanteenDishes);
        setUsingFallbackMenu(true);
      })
      .finally(() => {
        if (live) setMenuLoading(false);
      });
    return () => {
      live = false;
    };
  }, [menuVersion]);

  const track = useCallback(
    async (hash: string) => {
      if (!active) return;
      const updated: CanteenOrder = await api(`orders/${active.id}/transactions`, { txHash: hash });
      setOrders(old => old.map(o => (o.id === updated.id ? updated : o)));
      if (activeOrderId.current === updated.id) setActive(updated);
      return updated;
    },
    [active?.id],
  );

  const paid = useCallback(
    (hash: string) => {
      void track(hash).catch(e => setError(labels[e.message] ?? e.message));
    },
    [track],
  );

  async function open(order: CanteenOrder) {
    activeOrderId.current = order.id;
    setActive(order);
    setPreview(null);
    if (order.status === 'PAID') return;
    if (order.txHash) {
      const updated = await api(`orders/${order.id}/transactions`, { txHash: order.txHash });
      setActive(updated);
      if (updated.status === 'PAID') return;
    }
    const data = await api(`orders/${order.id}/prepare`, {});
    setActive(data.order);
    setOrders(old => old.map(o => (o.id === data.order.id ? data.order : o)));
    if (data.order.status === 'PAID' || data.order.status === 'EXPIRED') return;
    if (data.envelope && wallet) {
      const config = browserWalletConfig();
      if (!config.rpcUrl) throw Error('CONFIGURATION_ERROR');
      setPreview(await verifyInvoicePreview(JSON.stringify(data.envelope), wallet, config, createWalletRpc(config.rpcUrl)));
    }
  }

  return (
    <div className="canteen-workspace-stack">
      {/* Tầng 1: Lưới 2 cột chỉ bọc Thực đơn & Giỏ hàng để sticky cart không bao giờ đè xuống khu vực bên dưới */}
      <div className="canteen-order-stage">
        <section className="surface-panel canteen-menu-panel" aria-labelledby="canteen-menu-title" aria-busy={menuLoading}>
          <div className="canteen-menu-heading">
            <div>
              <span className="panel-eyebrow">CAMPUS KITCHEN</span>
              <h2 id="canteen-menu-title">Hôm nay ăn gì?</h2>
              <p>Một bữa ngon để tiếp tục những điều hay.</p>
            </div>
            <span className="canteen-demo-badge">
              {usingFallbackMenu ? 'Thực đơn mẫu (offline)' : `Thực đơn hôm nay (${dishes.length} món)`}
            </span>
          </div>
          {usingFallbackMenu ? (
            <div className="info-banner">
              <p>
                Đang hiển thị bộ 9 món ăn mẫu để bạn chọn thử. Muốn mô phỏng đặt đơn & biên lai ngay mà không cần ký ví?{' '}
                <button type="button" className="link-action-btn" onClick={onOpenDemo}>
                  Mở bản minh họa nhà ăn →
                </button>
              </p>
            </div>
          ) : null}

          <div className="canteen-menu-toolbar">
            <div className="library-filter-bar canteen-category-bar" role="group" aria-label="Phân loại món ăn">
              {(
                [
                  ['all', `Tất cả (${dishes.length})`],
                  ['main', `Món chính (${dishes.filter(d => (dishMetaById.get(d.id)?.category ?? 'main') === 'main').length})`],
                  ['snack-drink', `Ăn nhẹ & Đồ uống (${dishes.filter(d => dishMetaById.get(d.id)?.category === 'snack-drink').length})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`seg-btn ${categoryFilter === key ? 'active' : ''}`}
                  aria-pressed={categoryFilter === key}
                  onClick={() => setCategoryFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="canteen-inline-search">
              <label htmlFor="canteen-dish-search" className="sr-only">
                Tìm món ăn theo tên hoặc mô tả
              </label>
              <input
                id="canteen-dish-search"
                type="search"
                placeholder="Tìm nhanh món ăn…"
                value={dishSearch}
                onChange={e => setDishSearch(e.target.value)}
              />
            </div>
          </div>

          {menuLoading ? (
            <div className="canteen-menu-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              Đang chuẩn bị thực đơn…
            </div>
          ) : menuError ? (
            <div className="canteen-empty-state" role="alert">
              <Icon name="bowl" />
              <h3>Chưa tải được thực đơn</h3>
              <p>Kiểm tra kết nối và thử lại để chọn món.</p>
              <button type="button" className="secondary-btn" onClick={() => setMenuVersion(version => version + 1)}>
                Tải lại thực đơn
              </button>
            </div>
          ) : visibleDishes.length === 0 ? (
            <div className="canteen-empty-state">
              <Icon name="bowl" />
              <h3>Không tìm thấy món phù hợp</h3>
              <p>Hãy thử từ khóa khác hoặc chọn lại nhóm Tất cả.</p>
            </div>
          ) : (
            <>
              <div className="canteen-menu">
                {pagedDishes.map((dish, idx) => {
                  const globalIdx = (safeMenuPage - 1) * effectiveMenuSize + idx;
                  const meta = dishMetaById.get(dish.id);
                  return (
                    <article
                      key={dish.id}
                      className={`canteen-dish dish-tone-${globalIdx % 3} ${(cart[dish.id] ?? 0) > 0 ? 'dish-selected' : ''}`}
                    >
                      <div className="canteen-dish-header">
                        <DishArtwork dishId={dish.id} name={dish.name} category={meta?.category} />
                        <div className="canteen-dish-badges" aria-hidden="true">
                          <span className="dish-tag-pill">{meta?.badge ?? 'Món hôm nay'}</span>
                          <span className="dish-number tabular-nums">#{String(globalIdx + 1).padStart(2, '0')}</span>
                        </div>
                      </div>
                      <div className="canteen-dish-content">
                        <h3>{dish.name}</h3>
                        <p>{dish.description}</p>
                        <strong className="tabular-nums">{formatWalletBalance(BigInt(dish.priceWei))}</strong>
                      </div>
                      <div className="canteen-quantity">
                        <label htmlFor={`dish-quantity-${dish.id}`}>Số lượng {dish.name}</label>
                        <div className="quantity-stepper">
                          <button
                            type="button"
                            aria-label={`Giảm số lượng ${dish.name}`}
                            disabled={busy || !(cart[dish.id] ?? 0)}
                            onClick={() => setQuantity(dish.id, (cart[dish.id] ?? 0) - 1)}
                          >
                            −
                          </button>
                          <input
                            id={`dish-quantity-${dish.id}`}
                            type="number"
                            inputMode="numeric"
                            min="0"
                            step="1"
                            disabled={busy}
                            value={cart[dish.id] ?? 0}
                            onChange={event => setQuantity(dish.id, Number(event.target.value))}
                          />
                          <button
                            type="button"
                            aria-label={`Tăng số lượng ${dish.name}`}
                            disabled={busy || !Number.isSafeInteger((cart[dish.id] ?? 0) + 1)}
                            onClick={() => setQuantity(dish.id, (cart[dish.id] ?? 0) + 1)}
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              <PaginationBar
                total={visibleDishes.length}
                page={safeMenuPage}
                pageSize={menuPageSize}
                onPage={setMenuPage}
                onPageSize={setMenuPageSize}
                sizes={[6, 12, 0]}
                unitLabel="món ăn"
              />
            </>
          )}
          <div className="canteen-menu-note">
            <Icon name="shield" />
            <span>Giá và ưu đãi được đối chiếu trước khi bạn xác nhận trong ví.</span>
          </div>
        </section>

        <section ref={cartRef} id="canteen-cart-section" className="surface-panel canteen-cart" aria-labelledby="canteen-cart-title">
          <div className="panel-heading-with-icon">
            <span className="panel-icon icon-gold">
              <Icon name="utensils" />
            </span>
            <div>
              <span className="panel-eyebrow">BỮA ĂN CỦA BẠN</span>
              <h2 id="canteen-cart-title">Đơn của bạn</h2>
            </div>
            <span className="canteen-cart-count">{selectedDishes.length} món</span>
          </div>
          {selectedDishes.length ? (
            <ul className="canteen-cart-items">
              {selectedDishes.map(dish => (
                <li key={dish.id}>
                  <span>
                    {dish.name}
                    <small>× {cart[dish.id]}</small>
                  </span>
                  <strong>{formatWalletBalance(BigInt(dish.priceWei) * BigInt(cart[dish.id]))}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <div className="canteen-cart-empty">
              <DishArtwork emptyTray />
              <div>
                <strong>Khay ăn đang trống</strong>
                <p>Bấm dấu + ở thực đơn bên trái để chọn món ngon.</p>
              </div>
            </div>
          )}
          <div className="canteen-cart-total" aria-live="polite">
            <span>Tổng giá niêm yết</span>
            <strong className="tabular-nums">{formatWalletBalance(total)}</strong>
            {method === 'WALLET' && tier === 1 && total > BigInt(0) ? (
              <small className="canteen-sbt-estimate tabular-nums">
                Ưu đãi SBT (-10%): dự kiến thực trả {formatWalletBalance((total * BigInt(9)) / BigInt(10))}
              </small>
            ) : null}
          </div>
          <label className="canteen-payment-label" htmlFor="canteen-payment-method">
            Nguồn thanh toán
          </label>
          <select id="canteen-payment-method" value={method} onChange={e => setMethod(e.target.value as typeof method)}>
            <option value="WALLET">CAMPUS trong ví</option>
            <option value="FOOD">Học bổng FOOD</option>
          </select>
          <p className="canteen-payment-note">
            {method === 'WALLET'
              ? tier === 1
                ? 'Thẻ SBT hợp lệ · Tự động giảm 10% khi thanh toán.'
                : tier === 0
                  ? 'Tài khoản tiêu chuẩn · Áp dụng đúng giá niêm yết.'
                  : `Kết nối mạng IntraCampus ${CAMPUS_CHAIN_ID} để kiểm tra ưu đãi SBT.`
              : 'FOOD chi đúng tổng món; gas trả bằng CAMPUS trong ví.'}
          </p>
          <div className="canteen-cart-actions">
            {!wallet ? (
              <button type="button" className="primary-cta-btn" disabled={busy} onClick={onConnect}>
                Kết nối ví Core để đặt món
              </button>
            ) : (
              <>
                <button
                  className="primary-cta-btn"
                  disabled={busy || total === BigInt(0)}
                  onClick={() =>
                    void run(async () => {
                      if (!signed) {
                        const authResult = await signInLibraryStudent(wallet, sign);
                        if (authResult.status === 'error') throw Error(authResult.code);
                        if (authResult.status === 'sign-in-required') throw Error('UNAUTHENTICATED');
                        setSigned(true);
                        onSigned();
                      }
                      const key = `intracampus.canteen.create:${wallet}`;
                      const saved = localStorage.getItem(key);
                      const items = dishes
                        .filter(d => (cart[d.id] ?? 0) > 0)
                        .map(d => ({ dishId: d.id, quantity: cart[d.id] }));
                      const payload = JSON.stringify({ method, items });
                      let entry = saved ? JSON.parse(saved) : null;
                      if (entry && entry.payload !== payload) throw Error('Đơn trước chưa rõ kết quả. Giữ giỏ hàng và thử lại.');
                      if (!entry) {
                        entry = { payload, key: crypto.randomUUID() };
                        localStorage.setItem(key, JSON.stringify(entry));
                        setPendingCreate(true);
                      }
                      const order = await api('orders', { method, items, idempotencyKey: entry.key });
                      localStorage.removeItem(key);
                      setPendingCreate(false);
                      setOrders(old => [order, ...old.filter(o => o.id !== order.id)]);
                      setCart({});
                      await open(order);
                    })
                  }
                >
                  Tạo đơn và xem thanh toán
                </button>
                {signed ? (
                  <button
                    className="secondary-btn"
                    disabled={busy}
                    onClick={() => void run(async () => setOrders((await api('orders')).orders))}
                  >
                    Làm mới danh sách đơn
                  </button>
                ) : null}
                {pendingCreate ? (
                  <button
                    className="secondary-btn"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (!signed) {
                          const authResult = await signInLibraryStudent(wallet, sign);
                          if (authResult.status === 'error') throw Error(authResult.code);
                          if (authResult.status === 'sign-in-required') throw Error('UNAUTHENTICATED');
                          setSigned(true);
                          onSigned();
                        }
                        const key = `intracampus.canteen.create:${wallet}`;
                        const saved = localStorage.getItem(key);
                        if (!saved) {
                          setPendingCreate(false);
                          return;
                        }
                        const entry = JSON.parse(saved);
                        const payload = JSON.parse(entry.payload);
                        const order = await api('orders', { ...payload, idempotencyKey: entry.key });
                        localStorage.removeItem(key);
                        setPendingCreate(false);
                        setOrders(old => [order, ...old.filter(o => o.id !== order.id)]);
                        await open(order);
                      })
                    }
                  >
                    Khôi phục đơn chưa rõ kết quả
                  </button>
                ) : null}
              </>
            )}
          </div>
          {!wallet ? (
            <p className="canteen-sign-in-hint">
              <Icon name="shield" />
              Chưa có ví? Bạn có thể{' '}
              <button type="button" className="link-action-btn" onClick={onOpenDemo}>
                mở bản minh họa nhà ăn
              </button>
              .
            </p>
          ) : !signed ? (
            <p className="canteen-sign-in-hint">
              <Icon name="shield" />
              Lần tạo đơn đầu tiên sẽ yêu cầu ký xác nhận phiên ví (không tốn gas).
            </p>
          ) : null}
          {busy ? <p role="status">Đang xử lý…</p> : null}
          {error ? (
            <p className="error-panel" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>

      {/* Tầng 2: Chi tiết thanh toán & Sổ cái lịch sử đơn hoàn toàn tách rời khỏi vùng sticky của giỏ hàng */}
      <div className="canteen-lower-stack">
        {active ? (
          <section ref={activeOrderRef} className="surface-panel canteen-active-order">
            <div className="panel-top-row">
              <div>
                <span className="panel-eyebrow">CHI TIẾT & THANH TOÁN</span>
                <h2>Đơn #{active.id.slice(0, 8)}</h2>
              </div>
              <div className="inline-actions">
                <span
                  className={`network-pill ${active.status === 'PAID' ? 'pill-ok' : active.status === 'EXPIRED' ? 'pill-danger' : 'pill-warning'
                    }`}
                >
                  {active.status === 'PAID'
                    ? 'Đã thanh toán · đã xác minh'
                    : active.status === 'EXPIRED'
                      ? 'Hóa đơn hết hạn'
                      : 'Chờ thanh toán'}{' '}
                  · {active.method === 'FOOD' ? 'Học bổng FOOD' : 'CAMPUS trong ví'}
                </span>
                <button type="button" className="text-action-btn" onClick={() => setActive(null)}>
                  Đóng chi tiết
                </button>
              </div>
            </div>

            <ActiveOrderDetailsSummary order={active} />

            {active.status === 'PAID' ? (
              active.method === 'FOOD' ? (
                <p>
                  Nếu ví còn lượt FOOD đã xác minh, mở <Link href="/student#grant-title">Học bổng FOOD</Link> và đóng lượt đã xong trước khi chi đơn tiếp theo.
                </p>
              ) : null
            ) : active.status === 'EXPIRED' ? (
              <>
                <p>
                  Đơn đã hết hạn. Nếu chưa gửi giao dịch, chọn món và tạo đơn mới. Nếu đã yêu cầu ví ký, mở đơn để đối chiếu trước khi trả thêm.
                </p>
                <div className="inline-actions">
                  <button className="secondary-btn" disabled={busy} onClick={() => void run(() => open(active))}>
                    Đối chiếu đơn cũ
                  </button>
                </div>
              </>
            ) : active.method === 'FOOD' && active.afterBlock !== null ? (
              <CanteenFood order={active} onHash={track} />
            ) : preview ? (
              <PayInvoice preview={preview} onPaid={paid} />
            ) : (
              <div className="inline-actions">
                <button className="secondary-btn" disabled={busy} onClick={() => void run(() => open(active))}>
                  Mở thanh toán / đối chiếu đơn
                </button>
              </div>
            )}
          </section>
        ) : null}

        <CanteenOrderHistoryLedger
          orders={orders}
          activeOrderId={active?.id ?? null}
          busy={busy}
          emptyText="Đăng nhập bằng ví sinh viên để xem hoặc tra cứu các bữa ăn đã đặt."
          onSelectOrder={o => void run(() => open(o))}
        />
      </div>

      {totalPortions > 0 ? (
        <div className="canteen-floating-cart" role="region" aria-label="Tóm tắt giỏ hàng nhanh">
          <div className="floating-cart-info">
            <span>Đã chọn {totalPortions} phần</span>
            <strong className="tabular-value">{formatWalletBalance(total)}</strong>
          </div>
          <button
            type="button"
            className="primary-cta-btn"
            onClick={() => cartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            Xem đơn ↓
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CanteenDemoWorkspace({ onBackToLive }: { onBackToLive: () => void }) {
  const [categoryFilter, setCategoryFilter] = useState<'all' | CanteenDishCategory>('all');
  const [dishSearch, setDishSearch] = useState('');
  const [menuPage, setMenuPage] = useState(1);
  const [menuPageSize, setMenuPageSize] = useState(6);
  const [cart, setCart] = useState<Record<string, number>>({ 'com-tam': 1, 'tra-dao-cam-sa': 1 });
  const [method, setMethod] = useState<'WALLET' | 'FOOD'>('WALLET');
  const [hasSbtDiscount, setHasSbtDiscount] = useState(true);
  const [orders, setOrders] = useState<CanteenOrder[]>(demoCanteenOrders);
  const [active, setActive] = useState<CanteenOrder | null>(demoCanteenOrders[0]);
  const activeOrderRef = useRef<HTMLElement | null>(null);

  const visibleDishes = useMemo(() => {
    const q = dishSearch.trim().toLowerCase();
    return demoCanteenDishes.filter(d => {
      if (categoryFilter !== 'all' && d.category !== categoryFilter) return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q);
    });
  }, [categoryFilter, dishSearch]);

  useEffect(() => {
    setMenuPage(1);
  }, [categoryFilter, dishSearch]);

  const effectiveMenuSize = menuPageSize <= 0 ? Math.max(1, visibleDishes.length) : menuPageSize;
  const safeMenuPage = Math.min(menuPage, Math.max(1, Math.ceil(visibleDishes.length / effectiveMenuSize)));
  const pagedDishes = visibleDishes.slice((safeMenuPage - 1) * effectiveMenuSize, safeMenuPage * effectiveMenuSize);

  const selectedDishes = demoCanteenDishes.filter(d => (cart[d.id] ?? 0) > 0);
  const total = demoCanteenDishes.reduce((n, d) => n + BigInt(d.priceWei) * BigInt(cart[d.id] ?? 0), BigInt(0));
  const discountWei = method === 'WALLET' && hasSbtDiscount ? (total * BigInt(10)) / BigInt(100) : BigInt(0);
  const finalPayWei = total - discountWei;

  function setQuantity(id: string, quantity: number) {
    if (Number.isSafeInteger(quantity) && quantity >= 0) setCart(prev => ({ ...prev, [id]: quantity }));
  }

  function createDemoOrder() {
    if (total === BigInt(0)) return;
    const newOrder: CanteenOrder = {
      id: `${crypto.randomUUID().slice(0, 8)}-demo-${Date.now()}`,
      wallet: '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc',
      method,
      items: selectedDishes.map(d => ({
        dishId: d.id,
        name: d.name,
        unitPriceWei: d.priceWei,
        quantity: cart[d.id],
      })),
      totalWei: total.toString(),
      status: 'AWAITING_PAYMENT',
      createdAt: Date.now(),
      afterBlock: 38,
      invoiceId: method === 'WALLET' ? '0x7dec24e2691f51c0bc1822acf25d4b07c5bd73ed5d641cc604f22eead02e69b1' : null,
      txHash: null,
      paidAmountWei: null,
    };
    setOrders(prev => [newOrder, ...prev]);
    setActive(newOrder);
    setCart({});
    setTimeout(() => activeOrderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  }

  function simulateOrderState(status: CanteenOrder['status']) {
    if (!active) return;
    const activeTotal = BigInt(active.totalWei);
    const activePaid =
      active.method === 'WALLET' && hasSbtDiscount
        ? ((activeTotal * BigInt(90)) / BigInt(100)).toString()
        : activeTotal.toString();
    const updated: CanteenOrder = {
      ...active,
      status,
      txHash: status === 'PAID' ? '0x9b5a6c7d8e9f00112233445566778899aabbccddeeff00112233445566778899' : null,
      paidAmountWei: status === 'PAID' ? activePaid : null,
    };
    setActive(updated);
    setOrders(prev => prev.map(o => (o.id === updated.id ? updated : o)));
  }

  return (
    <>
      <section className="demo-control-strip demo-pill-bar" aria-label="Điều khiển bản minh họa nhà ăn">
        <div className="demo-pill-left">
          <span className="demo-pill-badge">
            <span className="mode-status-dot dot-demo" aria-hidden="true" />
            Bản minh họa · 9 món & 6 đơn mẫu
          </span>
          <div className="segmented-row" role="group" aria-label="Chọn ưu đãi SBT giả lập">
            <button
              type="button"
              className={`seg-btn ${hasSbtDiscount ? 'active' : ''}`}
              aria-pressed={hasSbtDiscount}
              onClick={() => setHasSbtDiscount(true)}
            >
              Có SBT (-10%)
            </button>
            <button
              type="button"
              className={`seg-btn ${!hasSbtDiscount ? 'active' : ''}`}
              aria-pressed={!hasSbtDiscount}
              onClick={() => setHasSbtDiscount(false)}
            >
              Ví thường (0%)
            </button>
          </div>
        </div>
        <div className="demo-pill-actions">
          <button type="button" className="secondary-btn btn-pill-sm" onClick={onBackToLive}>
            Nhà ăn thật →
          </button>
        </div>
      </section>

      <div className="canteen-workspace-stack">
        <div className="canteen-order-stage">
          <section className="surface-panel canteen-menu-panel" aria-labelledby="canteen-demo-menu-title">
            <div className="canteen-menu-heading">
              <div>
                <span className="panel-eyebrow">CAMPUS KITCHEN · BẢN MINH HỌA</span>
                <h2 id="canteen-demo-menu-title">Thực đơn hôm nay (9 món)</h2>
                <p>Đầy đủ món chính, bánh mì và đồ uống giải nhiệt cho giờ nghỉ trưa.</p>
              </div>
              <span className="canteen-demo-badge">Dữ liệu mẫu</span>
            </div>

            <div className="canteen-menu-toolbar">
              <div className="library-filter-bar canteen-category-bar" role="group" aria-label="Phân loại món ăn mẫu">
                {(
                  [
                    ['all', `Tất cả (${demoCanteenDishes.length})`],
                    ['main', `Món chính (${demoCanteenDishes.filter(d => d.category === 'main').length})`],
                    ['snack-drink', `Ăn nhẹ & Đồ uống (${demoCanteenDishes.filter(d => d.category === 'snack-drink').length})`],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`seg-btn ${categoryFilter === key ? 'active' : ''}`}
                    aria-pressed={categoryFilter === key}
                    onClick={() => setCategoryFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="canteen-inline-search">
                <label htmlFor="canteen-demo-dish-search" className="sr-only">
                  Tìm món ăn mẫu
                </label>
                <input
                  id="canteen-demo-dish-search"
                  type="search"
                  placeholder="Tìm nhanh món ăn…"
                  value={dishSearch}
                  onChange={e => setDishSearch(e.target.value)}
                />
              </div>
            </div>

            <div className="canteen-menu">
              {pagedDishes.map((dish, idx) => {
                const globalIdx = (safeMenuPage - 1) * effectiveMenuSize + idx;
                return (
                  <article
                    key={dish.id}
                    className={`canteen-dish dish-tone-${globalIdx % 3} ${(cart[dish.id] ?? 0) > 0 ? 'dish-selected' : ''}`}
                  >
                    <div className="canteen-dish-header">
                      <DishArtwork dishId={dish.id} name={dish.name} category={dish.category} />
                      <div className="canteen-dish-badges" aria-hidden="true">
                        <span className="dish-tag-pill">{dish.badge}</span>
                        <span className="dish-number tabular-nums">#{String(globalIdx + 1).padStart(2, '0')}</span>
                      </div>
                    </div>
                    <div className="canteen-dish-content">
                      <h3>{dish.name}</h3>
                      <p>{dish.description}</p>
                      <strong className="tabular-nums">{formatWalletBalance(BigInt(dish.priceWei))}</strong>
                    </div>
                    <div className="canteen-quantity">
                      <label htmlFor={`demo-dish-qty-${dish.id}`}>Số lượng {dish.name}</label>
                      <div className="quantity-stepper">
                        <button
                          type="button"
                          aria-label={`Giảm số lượng ${dish.name}`}
                          disabled={!(cart[dish.id] ?? 0)}
                          onClick={() => setQuantity(dish.id, (cart[dish.id] ?? 0) - 1)}
                        >
                          −
                        </button>
                        <input
                          id={`demo-dish-qty-${dish.id}`}
                          type="number"
                          inputMode="numeric"
                          min="0"
                          step="1"
                          value={cart[dish.id] ?? 0}
                          onChange={e => setQuantity(dish.id, Number(e.target.value))}
                        />
                        <button
                          type="button"
                          aria-label={`Tăng số lượng ${dish.name}`}
                          onClick={() => setQuantity(dish.id, (cart[dish.id] ?? 0) + 1)}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
            <PaginationBar
              total={visibleDishes.length}
              page={safeMenuPage}
              pageSize={menuPageSize}
              onPage={setMenuPage}
              onPageSize={setMenuPageSize}
              sizes={[6, 12, 0]}
              unitLabel="món ăn"
            />
          </section>

          <section className="surface-panel canteen-cart" aria-labelledby="canteen-demo-cart-title">
            <div className="panel-heading-with-icon">
              <span className="panel-icon icon-gold">
                <Icon name="utensils" />
              </span>
              <div>
                <span className="panel-eyebrow">GIỎ HÀNG MINH HỌA</span>
                <h2 id="canteen-demo-cart-title">Đơn mẫu của bạn</h2>
              </div>
              <span className="canteen-cart-count">{selectedDishes.length} món</span>
            </div>
            {selectedDishes.length ? (
              <ul className="canteen-cart-items">
                {selectedDishes.map(dish => (
                  <li key={dish.id}>
                    <span>
                      {dish.name}
                      <small>× {cart[dish.id]}</small>
                    </span>
                    <strong>{formatWalletBalance(BigInt(dish.priceWei) * BigInt(cart[dish.id]))}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="canteen-cart-empty">
                <DishArtwork emptyTray />
                <div>
                  <strong>Khay ăn mẫu đang trống</strong>
                  <p>Chọn món bên trái để tạo đơn thử nghiệm.</p>
                </div>
              </div>
            )}
            <dl className="price-breakdown">
              <div className="price-row">
                <dt>Tổng giá niêm yết</dt>
                <dd>{formatWalletBalance(total)}</dd>
              </div>
              {method === 'WALLET' && hasSbtDiscount ? (
                <div className="price-row discount-row">
                  <dt>Ưu đãi thẻ SBT (-10%)</dt>
                  <dd>-{formatWalletBalance(discountWei)}</dd>
                </div>
              ) : null}
              <div className="price-row total-row">
                <dt>Dự kiến thanh toán</dt>
                <dd>{formatWalletBalance(finalPayWei)}</dd>
              </div>
            </dl>
            <label className="canteen-payment-label" htmlFor="demo-canteen-method">
              Nguồn thanh toán
            </label>
            <select id="demo-canteen-method" value={method} onChange={e => setMethod(e.target.value as 'WALLET' | 'FOOD')}>
              <option value="WALLET">CAMPUS trong ví {hasSbtDiscount ? '(Giảm 10% SBT)' : '(Không giảm)'}</option>
              <option value="FOOD">Học bổng FOOD (Chi đúng giá món)</option>
            </select>
            <div className="canteen-cart-actions">
              <button type="button" className="primary-cta-btn" disabled={total === BigInt(0)} onClick={createDemoOrder}>
                Tạo đơn minh họa
              </button>
            </div>
          </section>
        </div>

        <div className="canteen-lower-stack">
          {active ? (
            <section ref={activeOrderRef} className="surface-panel canteen-active-order" aria-label="Chi tiết đơn mẫu">
              <div className="panel-top-row">
                <div>
                  <span className="panel-eyebrow">ĐƠN MẪU ĐANG MỞ</span>
                  <h2>Đơn #{active.id.slice(0, 8)}</h2>
                </div>
                <span
                  className={`network-pill ${active.status === 'PAID' ? 'pill-ok' : active.status === 'EXPIRED' ? 'pill-danger' : 'pill-warning'
                    }`}
                >
                  {active.status === 'PAID'
                    ? 'Đã thanh toán · dữ liệu mẫu'
                    : active.status === 'EXPIRED'
                      ? 'Hóa đơn hết hạn'
                      : 'Chờ thanh toán'}{' '}
                  · {active.method === 'FOOD' ? 'Học bổng FOOD' : 'CAMPUS trong ví'}
                </span>
              </div>

              <ActiveOrderDetailsSummary order={active} />

              <div className="library-actions">
                <button type="button" className="primary-cta-btn" disabled={active.status === 'PAID'} onClick={() => simulateOrderState('PAID')}>
                  Mô phỏng: Ký & Xác nhận thanh toán
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={active.status === 'AWAITING_PAYMENT'}
                  onClick={() => simulateOrderState('AWAITING_PAYMENT')}
                >
                  Đặt lại: Chờ thanh toán
                </button>
                <button type="button" className="secondary-btn" disabled={active.status === 'EXPIRED'} onClick={() => simulateOrderState('EXPIRED')}>
                  Mô phỏng: Hết hạn hóa đơn
                </button>
              </div>
            </section>
          ) : null}

          <CanteenOrderHistoryLedger
            orders={orders}
            activeOrderId={active?.id ?? null}
            demoMode
            emptyText="Chưa có đơn ăn mẫu."
            onSelectOrder={o => setActive(o)}
          />
        </div>
      </div>
    </>
  );
}
