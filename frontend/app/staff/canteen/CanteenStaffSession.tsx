'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CanteenDish } from '@intracampus/network';
import { formatWalletBalance, formatWalletBalanceCompact } from '../../../lib/chains';
import HashChip from '../../components/HashChip';
import Icon from '../../components/Icon';
import DishArtwork from '../../components/DishArtwork';
import PageHeading from '../../components/PageHeading';
import PaginationBar from '../../components/PaginationBar';
import {
  DEMO_CANTEEN_MERCHANT_WALLET,
  demoCanteenDishes,
  demoCanteenStaffOrders,
  type CanteenStaffOrder,
} from '../../demo-fixtures';

function ticketCode(orderId: string): string {
  return orderId.replace(/-/g, '').slice(0, 4).toUpperCase();
}

function timeShort(ts: number): string {
  const ms = ts < 1e11 ? ts * 1000 : ts;
  return new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function summarizeItems(order: CanteenStaffOrder): string {
  return order.items.map(i => `${i.name} ×${i.quantity}`).join(', ');
}

export default function CanteenStaffSession() {
  const [mode, setMode] = useState<'live' | 'demo'>('live');

  return (
    <div className="library-shell canteen-shell canteen-staff-shell">
      <PageHeading
        eyebrow="QUẦY PHỤC VỤ NHÀ ĂN"
        title="Bếp & Giao khay nhà ăn"
        description="Ví nhà ăn đã liên kết sẵn. Chỉ hiện đơn đã thu tiền để các cô múc món và bấm giao khay."
        icon="utensils"
      >
        <div className="mode-switch-wrapper">
          <span className="mode-switch-kicker">
            <span className={`mode-status-dot ${mode === 'live' ? 'dot-live' : 'dot-demo'}`} aria-hidden="true" />
            {mode === 'live' ? 'Avalanche L1 · Chain 20261' : 'Bản minh họa'}
          </span>
          <div className="student-mode-switch" role="group" aria-label="Chế độ quầy nhà ăn">
            <button type="button" className="secondary-btn" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>
              Quầy bếp thật
            </button>
            <button type="button" className="secondary-btn" aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}>
              Xem bản minh họa
            </button>
          </div>
        </div>
        <Link className="secondary-btn" href="/student/canteen">
          Trang sinh viên đặt món
        </Link>
      </PageHeading>

      {mode === 'live' ? (
        <LiveCanteenCounter onOpenDemo={() => setMode('demo')} />
      ) : (
        <DemoCanteenCounter onBackToLive={() => setMode('live')} />
      )}
    </div>
  );
}

function LiveCanteenCounter({ onOpenDemo }: { onOpenDemo: () => void }) {
  const [merchantWallet, setMerchantWallet] = useState<string | null>(null);
  const [dishes, setDishes] = useState<CanteenDish[]>([]);
  const [orders, setOrders] = useState<CanteenStaffOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [offlineFallback, setOfflineFallback] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const loadOverview = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/canteen/staff/overview', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error('SERVICE_UNAVAILABLE');
      const data = (await res.json()) as {
        merchantWallet: string | null;
        dishes: CanteenDish[];
        orders: CanteenStaffOrder[];
      };
      setMerchantWallet(data.merchantWallet ?? DEMO_CANTEEN_MERCHANT_WALLET);
      setDishes(data.dishes);
      setOrders(data.orders);
      setOfflineFallback(false);
      setError('');
    } catch {
      if (!silent) {
        setMerchantWallet(DEMO_CANTEEN_MERCHANT_WALLET);
        setDishes(demoCanteenDishes);
        setOrders([]);
        setOfflineFallback(true);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview(false);
  }, [loadOverview]);

  useEffect(() => {
    if (!autoRefresh || offlineFallback) return;
    const timer = window.setInterval(() => {
      void loadOverview(true);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [autoRefresh, offlineFallback, loadOverview]);

  async function handleServe(orderId: string, served: boolean) {
    setBusyId(orderId);
    setError('');
    setNotice('');
    try {
      const res = await fetch(`/api/canteen/staff/orders/${encodeURIComponent(orderId)}/serve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ served }),
      });
      if (!res.ok) throw new Error('Chưa cập nhật được trạng thái giao khay. Vui lòng thử lại.');
      const updated = (await res.json()) as CanteenStaffOrder;
      setOrders(prev => prev.map(o => (o.id === updated.id ? updated : o)));
      setNotice(
        served
          ? `Đã đánh dấu giao xong Phiếu #${ticketCode(orderId)}.`
          : `Đã hoàn tác: Phiếu #${ticketCode(orderId)} quay lại danh sách cần múc món.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Có lỗi kết nối máy chủ.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleDish(dishId: string, active: boolean) {
    setBusyId(dishId);
    setError('');
    setNotice('');
    try {
      const res = await fetch(`/api/canteen/staff/dishes/${encodeURIComponent(dishId)}/availability`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error('Chưa đổi được trạng thái món ăn. Kiểm tra kết nối máy chủ.');
      const data = (await res.json()) as { dish: CanteenDish };
      setDishes(prev => prev.map(d => (d.id === data.dish.id ? data.dish : d)));
      setNotice(
        active
          ? `Đã mở bán lại món "${data.dish.name}" trên màn hình sinh viên.`
          : `Đã báo hết món "${data.dish.name}" — sinh viên sẽ tạm thời không đặt món này nữa.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Có lỗi kết nối máy chủ.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {offlineFallback ? (
        <div className="info-banner">
          <p>
            Chưa kết nối được máy chủ căn-tin thật. Bạn có thể bấm{' '}
            <button type="button" className="link-action-btn" onClick={onOpenDemo}>
              Xem bản minh họa quầy bếp có sẵn 8 đơn mẫu →
            </button>
          </p>
        </div>
      ) : null}
      <CanteenCounterUI
        merchantWallet={merchantWallet ?? DEMO_CANTEEN_MERCHANT_WALLET}
        dishes={dishes}
        orders={orders}
        loading={loading}
        busyId={busyId}
        autoRefresh={autoRefresh}
        onToggleAutoRefresh={() => setAutoRefresh(prev => !prev)}
        onManualRefresh={() => void loadOverview(false)}
        onServe={handleServe}
        onToggleDish={handleToggleDish}
        notice={notice}
        error={error}
      />
    </>
  );
}

const RANDOM_DEMO_COMBOS: Array<{
  method: 'WALLET' | 'FOOD';
  sbt: boolean;
  items: Array<{ id: string; qty: number }>;
}> = [
  { method: 'WALLET', sbt: true, items: [{ id: 'com-tam', qty: 1 }, { id: 'tra-dao-cam-sa', qty: 1 }] },
  { method: 'FOOD', sbt: false, items: [{ id: 'mi-quang-ga', qty: 1 }, { id: 'sua-chua-trai-cay', qty: 1 }] },
  { method: 'WALLET', sbt: true, items: [{ id: 'bun-bo', qty: 2 }, { id: 'ca-phe-sua-da', qty: 2 }] },
  { method: 'WALLET', sbt: false, items: [{ id: 'banh-mi-cha-lua', qty: 2 }] },
];

function DemoCanteenCounter({ onBackToLive }: { onBackToLive: () => void }) {
  const [dishes, setDishes] = useState<CanteenDish[]>(demoCanteenDishes);
  const [orders, setOrders] = useState<CanteenStaffOrder[]>(demoCanteenStaffOrders);
  const [simStep, setSimStep] = useState(0);
  const [notice, setNotice] = useState('');

  function simulateIncomingPaidOrder() {
    const combo = RANDOM_DEMO_COMBOS[simStep % RANDOM_DEMO_COMBOS.length];
    setSimStep(prev => prev + 1);
    const items = combo.items.map(entry => {
      const dish = dishes.find(d => d.id === entry.id) ?? demoCanteenDishes[0];
      return {
        dishId: dish.id,
        name: dish.name,
        unitPriceWei: dish.priceWei,
        quantity: entry.qty,
      };
    });
    const total = items.reduce((s, i) => s + BigInt(i.unitPriceWei) * BigInt(i.quantity), BigInt(0));
    const paid = combo.method === 'WALLET' && combo.sbt ? (total * BigInt(9)) / BigInt(10) : total;
    const prefix = Math.floor(1000 + Math.random() * 9000).toString(16).padStart(4, 'b');
    const newOrder: CanteenStaffOrder = {
      id: `${prefix}c901-demo-${Date.now()}`,
      payerHint: '0x5a12…88e1',
      method: combo.method,
      items,
      totalWei: total.toString(),
      status: 'PAID',
      createdAt: Date.now(),
      afterBlock: 42 + simStep,
      invoiceId: combo.method === 'WALLET' ? '0x88a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e01' : null,
      txHash: '0x99a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e02',
      paidAmountWei: paid.toString(),
      servedAt: null,
    };
    setOrders(prev => [newOrder, ...prev]);
    setNotice(
      `Có đơn mới #${ticketCode(newOrder.id)} vừa thanh toán xong (${formatWalletBalance(paid)})! Mời cô múc món.`,
    );
  }

  return (
    <>
      <section className="demo-control-strip demo-pill-bar" aria-label="Điều khiển bản minh họa quầy nhà ăn">
        <div className="demo-pill-left">
          <span className="demo-pill-badge">
            <span className="mode-status-dot dot-demo" aria-hidden="true" />
            Bản minh họa quầy bếp · Dữ liệu mẫu
          </span>
          <span className="demo-pill-summary">Thử nhận phiếu chữ to, giao khay 1 chạm hoặc báo hết món</span>
        </div>
        <div className="demo-pill-actions">
          <button type="button" className="primary-cta-btn btn-pill-sm" onClick={simulateIncomingPaidOrder}>
            + Giả lập đơn vừa trả tiền
          </button>
          <button
            type="button"
            className="secondary-btn btn-pill-sm"
            onClick={() => {
              setDishes(demoCanteenDishes);
              setOrders(demoCanteenStaffOrders);
              setNotice('Đã khôi phục danh sách phiếu bếp và thực đơn mẫu.');
            }}
          >
            Đặt lại
          </button>
          <button type="button" className="secondary-btn btn-pill-sm" onClick={onBackToLive}>
            Quầy bếp thật →
          </button>
        </div>
      </section>

      <CanteenCounterUI
        merchantWallet={DEMO_CANTEEN_MERCHANT_WALLET}
        dishes={dishes}
        orders={orders}
        loading={false}
        busyId={null}
        demoMode
        notice={notice}
        error=""
        onServe={(id, served) => {
          setOrders(prev =>
            prev.map(o => (o.id === id ? { ...o, servedAt: served ? Date.now() : null } : o)),
          );
          setNotice(
            served
              ? `Đã giao xong Phiếu #${ticketCode(id)} cho sinh viên!`
              : `Đã hoàn tác: Phiếu #${ticketCode(id)} được đưa lại lên bảng chờ giao.`,
          );
        }}
        onToggleDish={(id, active) => {
          const target = dishes.find(d => d.id === id);
          setDishes(prev => prev.map(d => (d.id === id ? { ...d, active } : d)));
          if (target) {
            setNotice(
              active
                ? `Đã mở bán lại món "${target.name}".`
                : `Đã tạm báo hết món "${target.name}".`,
            );
          }
        }}
      />
    </>
  );
}

function CanteenCounterUI({
  merchantWallet,
  dishes,
  orders,
  loading,
  busyId,
  demoMode = false,
  autoRefresh,
  onToggleAutoRefresh,
  onManualRefresh,
  onServe,
  onToggleDish,
  notice,
  error,
}: {
  merchantWallet: string;
  dishes: CanteenDish[];
  orders: CanteenStaffOrder[];
  loading: boolean;
  busyId: string | null;
  demoMode?: boolean;
  autoRefresh?: boolean;
  onToggleAutoRefresh?: () => void;
  onManualRefresh?: () => void;
  onServe: (orderId: string, served: boolean) => void;
  onToggleDish: (dishId: string, active: boolean) => void;
  notice: string;
  error: string;
}) {
  const [tab, setTab] = useState<'kitchen' | 'menu' | 'ledger'>('kitchen');
  const [kitchenPage, setKitchenPage] = useState(1);
  const [kitchenPageSize, setKitchenPageSize] = useState(6);

  const [menuFilter, setMenuFilter] = useState<'all' | 'active' | 'out'>('all');
  const [menuSearch, setMenuSearch] = useState('');
  const [menuPage, setMenuPage] = useState(1);
  const [menuPageSize, setMenuPageSize] = useState(6);

  const [ledgerFilter, setLedgerFilter] = useState<'all' | 'waiting-tray' | 'served' | 'unpaid'>('all');
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerPageSize, setLedgerPageSize] = useState(6);

  // Đơn đã thu tiền nhưng chưa giao khay -> xếp FIFO (ai trả trước làm trước)
  const readyToServe = useMemo(
    () =>
      orders
        .filter(o => o.status === 'PAID' && o.servedAt === null)
        .sort((a, b) => a.createdAt - b.createdAt),
    [orders],
  );

  // Đơn vừa giao gần đây nhất (hiện 3 đơn dưới đáy bảng bếp để bấm Hoàn tác nhanh nếu lỡ tay)
  const recentlyServed = useMemo(
    () =>
      orders
        .filter(o => o.status === 'PAID' && o.servedAt !== null)
        .sort((a, b) => (b.servedAt ?? 0) - (a.servedAt ?? 0)),
    [orders],
  );

  const unpaidPendingCount = useMemo(
    () => orders.filter(o => o.status === 'AWAITING_PAYMENT').length,
    [orders],
  );

  const revenueStats = useMemo(() => {
    const paidOrders = orders.filter(o => o.status === 'PAID');
    const walletWei = paidOrders
      .filter(o => o.method === 'WALLET')
      .reduce((sum, o) => sum + BigInt(o.paidAmountWei ?? o.totalWei), BigInt(0));
    const foodWei = paidOrders
      .filter(o => o.method === 'FOOD')
      .reduce((sum, o) => sum + BigInt(o.paidAmountWei ?? o.totalWei), BigInt(0));
    return {
      totalWei: walletWei + foodWei,
      walletWei,
      foodWei,
      paidCount: paidOrders.length,
    };
  }, [orders]);

  const activeDishCount = dishes.filter(d => d.active).length;

  const filteredMenu = useMemo(() => {
    const q = menuSearch.trim().toLowerCase();
    return dishes.filter(d => {
      if (menuFilter === 'active' && !d.active) return false;
      if (menuFilter === 'out' && d.active) return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q);
    });
  }, [dishes, menuFilter, menuSearch]);

  const filteredLedger = useMemo(() => {
    const q = ledgerSearch.trim().toLowerCase().replace(/^#/, '');
    return orders.filter(o => {
      if (ledgerFilter === 'waiting-tray' && !(o.status === 'PAID' && o.servedAt === null)) return false;
      if (ledgerFilter === 'served' && !(o.status === 'PAID' && o.servedAt !== null)) return false;
      if (ledgerFilter === 'unpaid' && o.status === 'PAID') return false;
      if (!q) return true;
      return (
        ticketCode(o.id).toLowerCase().includes(q) ||
        o.id.toLowerCase().includes(q) ||
        o.items.some(i => i.name.toLowerCase().includes(q))
      );
    });
  }, [orders, ledgerFilter, ledgerSearch]);

  useEffect(() => { setMenuPage(1); }, [menuFilter, menuSearch]);
  useEffect(() => { setLedgerPage(1); }, [ledgerFilter, ledgerSearch]);

  const kSize = kitchenPageSize <= 0 ? Math.max(1, readyToServe.length) : kitchenPageSize;
  const safeKitchenPage = Math.min(kitchenPage, Math.max(1, Math.ceil(readyToServe.length / kSize)));
  const pagedKitchen = readyToServe.slice((safeKitchenPage - 1) * kSize, safeKitchenPage * kSize);

  const mSize = menuPageSize <= 0 ? Math.max(1, filteredMenu.length) : menuPageSize;
  const safeMenuPage = Math.min(menuPage, Math.max(1, Math.ceil(filteredMenu.length / mSize)));
  const pagedMenu = filteredMenu.slice((safeMenuPage - 1) * mSize, safeMenuPage * mSize);

  const lSize = ledgerPageSize <= 0 ? Math.max(1, filteredLedger.length) : ledgerPageSize;
  const safeLedgerPage = Math.min(ledgerPage, Math.max(1, Math.ceil(filteredLedger.length / lSize)));
  const pagedLedger = filteredLedger.slice((safeLedgerPage - 1) * lSize, safeLedgerPage * lSize);

  return (
    <div className="canteen-staff-stack">
      {/* Thanh Ví Nhà Ăn Đã Liên Kết Sẵn — Không yêu cầu các cô thao tác ví */}
      <section className="canteen-linked-wallet-bar" aria-label="Trạng thái ví nhà ăn đã liên kết">
        <div className="linked-wallet-main">
          <div className="linked-wallet-badge-row">
            <span className="network-pill pill-ok">
              <span className="status-dot" aria-hidden="true" />
              Ví nhận tiền Nhà Ăn đã liên kết sẵn · Tự động nhận tiền
            </span>
            {demoMode ? <span className="fixture-pill">Dữ liệu mẫu</span> : null}
          </div>
          <p className="linked-wallet-guide">
            Các cô <strong>không cần kết nối ví hay ký xác nhận</strong>. Cứ thấy phiếu có dấu xanh{' '}
            <strong>&ldquo;✓ ĐÃ THU TIỀN&rdquo;</strong> là tiền đã vào ví nhà ăn an toàn, có thể múc món giao ngay!
          </p>
          <details className="accountant-wallet-details">
            <summary>Xem mã ví liên kết (dành cho bộ phận kế toán đối chiếu)</summary>
            <div className="staff-meta-chips">
              <span>
                Ví căn-tin nhận tự động:{' '}
                <HashChip value={merchantWallet} start={8} end={6} copyLabel="Sao chép địa chỉ ví nhà ăn" />
              </span>
              <span>Mạng: IntraCampus L1 · Chain 20261</span>
            </div>
          </details>
        </div>
        {!demoMode ? (
          <div className="linked-wallet-actions">
            {onToggleAutoRefresh ? (
              <button
                type="button"
                className={`secondary-btn ${autoRefresh ? 'btn-live-polling' : ''}`}
                aria-pressed={autoRefresh}
                onClick={onToggleAutoRefresh}
              >
                {autoRefresh ? '● Đang tự nhận đơn (3s)' : 'Tự nhận đơn: Tạm dừng'}
              </button>
            ) : null}
            {onManualRefresh ? (
              <button type="button" className="secondary-btn" disabled={loading} onClick={onManualRefresh}>
                Làm mới ngay
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {notice ? (
        <p className="canteen-staff-toast" role="status">
          <Icon name="check" /> {notice}
        </p>
      ) : null}
      {error ? (
        <p className="error-panel" role="alert">
          {error}
        </p>
      ) : null}

      {/* 3 Ô Số To Rõ Cho Các Cô Dễ Theo Dõi */}
      <div className="canteen-kitchen-kpis" role="region" aria-label="Chỉ số phục vụ trong ca">
        <button
          type="button"
          className={`staff-kpi-card kitchen-kpi-card ${readyToServe.length > 0 ? 'kpi-urgent-card' : ''}`}
          onClick={() => setTab('kitchen')}
        >
          <span className="kpi-label">1. Cần múc & giao ngay</span>
          <strong className="kpi-value kitchen-kpi-big tabular-value">{readyToServe.length} khay</strong>
          <span className={`kpi-sub ${readyToServe.length > 0 ? 'kpi-sub-warn' : ''}`}>
            {readyToServe.length > 0
              ? 'Đã thu tiền xong · Sinh viên đang chờ lấy'
              : 'Hiện không có khay nào đang chờ'}
          </span>
        </button>

        <button
          type="button"
          className="staff-kpi-card kitchen-kpi-card"
          onClick={() => {
            setTab('ledger');
            setLedgerFilter('served');
          }}
        >
          <span className="kpi-label">2. Đã giao xong trong ca</span>
          <strong className="kpi-value kitchen-kpi-big tabular-value">{recentlyServed.length} khay</strong>
          <span className="kpi-sub">Bấm vào đây nếu cần xem lại hoặc hoàn tác</span>
        </button>

        <button
          type="button"
          className="staff-kpi-card kitchen-kpi-card"
          onClick={() => {
            setTab('ledger');
            setLedgerFilter('all');
          }}
        >
          <span className="kpi-label">3. Tiền đã vào ví nhà ăn ({revenueStats.paidCount} đơn)</span>
          <strong className="kpi-value kitchen-kpi-big kpi-emerald tabular-value">
            {formatWalletBalanceCompact(revenueStats.totalWei, 2).display}
          </strong>
          <span className="kpi-sub tabular-value">
            Ví SV: {formatWalletBalanceCompact(revenueStats.walletWei, 2).display} · Học bổng FOOD:{' '}
            {formatWalletBalanceCompact(revenueStats.foodWei, 2).display}
          </span>
        </button>
      </div>

      {/* 3 Tab Chữ Lớn, Thao Tác Đơn Giản */}
      <div className="library-filter-bar canteen-staff-tabs" role="group" aria-label="Chọn màn hình làm việc nhà ăn">
        <button
          type="button"
          className={`seg-btn ${tab === 'kitchen' ? 'active' : ''}`}
          aria-pressed={tab === 'kitchen'}
          onClick={() => setTab('kitchen')}
        >
          1. Cần giao món ({readyToServe.length})
        </button>
        <button
          type="button"
          className={`seg-btn ${tab === 'menu' ? 'active' : ''}`}
          aria-pressed={tab === 'menu'}
          onClick={() => setTab('menu')}
        >
          2. Bật / Báo hết món ({activeDishCount}/{dishes.length} đang bán)
        </button>
        <button
          type="button"
          className={`seg-btn ${tab === 'ledger' ? 'active' : ''}`}
          aria-pressed={tab === 'ledger'}
          onClick={() => setTab('ledger')}
        >
          3. Sổ đơn hôm nay ({orders.length})
        </button>
      </div>

      {/* MÀN HÌNH 1: BẢNG PHIẾU BẾP CHỮ TO */}
      {tab === 'kitchen' ? (
        <section className="surface-panel kitchen-board-panel" aria-label="Bảng phiếu món cần giao">
          <div className="staff-section-top">
            <div>
              <span className="eyebrow">QUẦY MÚC MÓN & GIAO KHAY</span>
              <h2>Đơn đã trả tiền · chờ giao khay ({readyToServe.length})</h2>
              <p className="muted-line">Đơn đặt trước xếp lên đầu. Các cô đọc 4 chữ số mã phiếu để gọi sinh viên nhận khay.</p>
            </div>
          </div>

          {loading ? (
            <div className="canteen-menu-loading" role="status">
              <span className="spinner" aria-hidden="true" />
              Đang kiểm tra đơn mới…
            </div>
          ) : readyToServe.length === 0 ? (
            <div className="kitchen-all-clear">
              <span className="kitchen-clear-icon">
                <Icon name="check" />
              </span>
              <h3>Đã giao hết các khay đang chờ!</h3>
              <p>Khi sinh viên thanh toán xong đơn mới, phiếu chữ to sẽ tự động hiện ngay tại đây.</p>
            </div>
          ) : (
            <>
              <div className="kitchen-tickets-grid">
                {pagedKitchen.map(order => {
                  const paidWei = BigInt(order.paidAmountWei ?? order.totalWei);
                  const totalPortions = order.items.reduce((s, i) => s + i.quantity, 0);
                  const code = ticketCode(order.id);
                  return (
                    <article key={order.id} className="kitchen-ticket-card" aria-label={`Phiếu ${code}`}>
                      <div className="kitchen-ticket-header">
                        <div>
                          <span className="kitchen-ticket-kicker">MÃ GỌI SINH VIÊN</span>
                          <strong className="kitchen-ticket-number tabular-value">PHIẾU #{code}</strong>
                          <span className="kitchen-ticket-time tabular-value">
                            Đặt lúc {timeShort(order.createdAt)} · {totalPortions} phần
                          </span>
                        </div>
                        <div className="kitchen-paid-stamp">
                          <span className="paid-stamp-badge">
                            <Icon name="check" /> ĐÃ THU TIỀN
                          </span>
                          <strong className="paid-stamp-amount tabular-value">{formatWalletBalance(paidWei)}</strong>
                          <small>{order.method === 'FOOD' ? 'Quỹ Học bổng FOOD' : 'Ví CAMPUS sinh viên'}</small>
                        </div>
                      </div>

                      <ul className="kitchen-dish-lines">
                        {order.items.map(item => (
                          <li key={item.dishId}>
                            <span className="kitchen-qty-pill tabular-value">{item.quantity}×</span>
                            <strong className="kitchen-dish-name">{item.name}</strong>
                          </li>
                        ))}
                      </ul>

                      <button
                        type="button"
                        className="primary-cta-btn kitchen-serve-btn"
                        disabled={busyId === order.id}
                        onClick={() => onServe(order.id, true)}
                      >
                        <Icon name="check" />
                        {busyId === order.id ? 'Đang lưu…' : `✓ Đã giao khay #${code} cho sinh viên`}
                      </button>
                    </article>
                  );
                })}
              </div>

              <PaginationBar
                total={readyToServe.length}
                page={safeKitchenPage}
                pageSize={kitchenPageSize}
                onPage={setKitchenPage}
                onPageSize={setKitchenPageSize}
                sizes={[6, 12, 0]}
                unitLabel="phiếu chờ giao"
              />
            </>
          )}

          {/* Dải Vừa giao gần đây: Để cô bấm Hoàn tác 1 chạm nếu lỡ tay bấm nhầm */}
          {recentlyServed.length > 0 ? (
            <div className="kitchen-recent-strip">
              <div className="staff-section-top">
                <div>
                  <h3 className="layer-heading">Vừa giao gần đây (bấm Hoàn tác nếu chạm nhầm)</h3>
                </div>
                {recentlyServed.length > 3 ? (
                  <button
                    type="button"
                    className="text-action-btn"
                    onClick={() => {
                      setTab('ledger');
                      setLedgerFilter('served');
                    }}
                  >
                    Xem toàn bộ {recentlyServed.length} đơn đã giao →
                  </button>
                ) : null}
              </div>
              <div className="ledger-compact-list">
                {recentlyServed.slice(0, 3).map(order => (
                  <div key={order.id} className="ledger-compact-row">
                    <div className="ledger-row-summary canteen-ledger-row">
                      <span className="ledger-date tabular-value">Giao {timeShort(order.servedAt!)}</span>
                      <div className="ledger-book-cell">
                        <strong>Phiếu #{ticketCode(order.id)} · {summarizeItems(order)}</strong>
                      </div>
                      <span className="network-pill pill-ok">Đã giao khay</span>
                      <button
                        type="button"
                        className="secondary-btn pagination-btn"
                        disabled={busyId === order.id}
                        onClick={() => onServe(order.id, false)}
                      >
                        ↶ Hoàn tác (chưa giao)
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {unpaidPendingCount > 0 ? (
            <div className="kitchen-unpaid-note">
              <p>
                <strong>Lưu ý tự động:</strong> Đang có <strong>{unpaidPendingCount} đơn</strong> sinh viên mới chọn món nhưng{' '}
                <strong>chưa bấm thanh toán trên điện thoại</strong>. Hệ thống tự ẩn khỏi bảng bếp để các cô không múc nhầm; ngay khi sinh viên trả xong, phiếu sẽ tự hiện lên trên.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* MÀN HÌNH 2: BẬT / BÁO HẾT MÓN 1 CHẠM */}
      {tab === 'menu' ? (
        <section className="surface-panel" aria-label="Quản lý bật tắt thực đơn">
          <div className="staff-section-top">
            <div>
              <span className="eyebrow">QUẢN LÝ MÓN TRONG NGÀY</span>
              <h2>Bật mở bán / Báo hết món ({dishes.length} món)</h2>
              <p className="muted-line">Hết món nào các cô chỉ cần bấm &ldquo;Tạm báo hết món&rdquo; — điện thoại sinh viên sẽ tự ẩn ngay để không đặt nhầm.</p>
            </div>
            <div className="ledger-toolbar-controls">
              <div className="segmented-row" role="group" aria-label="Lọc món đang bán hoặc đã hết">
                <button
                  type="button"
                  className={`seg-btn ${menuFilter === 'all' ? 'active' : ''}`}
                  aria-pressed={menuFilter === 'all'}
                  onClick={() => setMenuFilter('all')}
                >
                  Tất cả ({dishes.length})
                </button>
                <button
                  type="button"
                  className={`seg-btn ${menuFilter === 'active' ? 'active' : ''}`}
                  aria-pressed={menuFilter === 'active'}
                  onClick={() => setMenuFilter('active')}
                >
                  Đang bán ({activeDishCount})
                </button>
                <button
                  type="button"
                  className={`seg-btn ${menuFilter === 'out' ? 'active' : ''}`}
                  aria-pressed={menuFilter === 'out'}
                  onClick={() => setMenuFilter('out')}
                >
                  Đã báo hết ({dishes.length - activeDishCount})
                </button>
              </div>
              <div className="canteen-inline-search">
                <label htmlFor="staff-menu-search" className="sr-only">
                  Tìm tên món ăn
                </label>
                <input
                  id="staff-menu-search"
                  type="search"
                  placeholder="Tìm tên món…"
                  value={menuSearch}
                  onChange={e => setMenuSearch(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="staff-inventory-grid">
            {pagedMenu.map(dish => (
              <article
                key={dish.id}
                className={`staff-book-card canteen-manage-dish-card ${!dish.active ? 'book-out-of-stock' : ''}`}
              >
                <div className="staff-record-head">
                  <div className="book-card-header">
                    <DishArtwork dishId={dish.id} name={dish.name} />
                    <div className="staff-record-main">
                      <div className="staff-title-row">
                        <h3>{dish.name}</h3>
                        <span className={`network-pill ${dish.active ? 'pill-ok' : 'pill-danger'}`}>
                          <span className="status-dot" aria-hidden="true" />
                          {dish.active ? 'Đang mở bán' : 'Đã báo hết'}
                        </span>
                      </div>
                      <p className="muted-line">{dish.description}</p>
                      <strong className="canteen-manage-price tabular-value">
                        {formatWalletBalance(BigInt(dish.priceWei))}
                      </strong>
                    </div>
                  </div>
                  <div className="library-actions staff-actions-right">
                    {dish.active ? (
                      <button
                        type="button"
                        className="secondary-btn dish-toggle-btn"
                        disabled={busyId === dish.id}
                        onClick={() => onToggleDish(dish.id, false)}
                      >
                        Tạm báo hết món
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="primary-cta-btn dish-toggle-btn"
                        disabled={busyId === dish.id}
                        onClick={() => onToggleDish(dish.id, true)}
                      >
                        Mở bán lại ngay
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>

          <PaginationBar
            total={filteredMenu.length}
            page={safeMenuPage}
            pageSize={menuPageSize}
            onPage={setMenuPage}
            onPageSize={setMenuPageSize}
            sizes={[6, 12, 0]}
            unitLabel="món ăn"
          />
        </section>
      ) : null}

      {/* MÀN HÌNH 3: SỔ ĐƠN HÔM NAY & TRA CỨU NHANH 4 KÝ TỰ */}
      {tab === 'ledger' ? (
        <section className="surface-panel" aria-label="Sổ đơn nhà ăn hôm nay">
          <div className="staff-section-top">
            <div>
              <span className="eyebrow">TRA CỨU & ĐỐI CHIẾU CUỐI CA</span>
              <h2>Sổ đơn trong ngày ({orders.length})</h2>
              <p className="muted-line">Khi sinh viên hỏi đơn, cô chỉ cần gõ 4 ký tự đầu của phiếu (ví dụ: 9F42 hoặc D5F8) để kiểm tra ngay.</p>
            </div>
            <div className="ledger-toolbar-controls">
              <div className="segmented-row" role="group" aria-label="Lọc sổ đơn nhà ăn">
                {(
                  [
                    ['all', `Tất cả (${orders.length})`],
                    ['waiting-tray', `Chờ giao khay (${readyToServe.length})`],
                    ['served', `Đã giao xong (${recentlyServed.length})`],
                    ['unpaid', `Chưa trả / hết hạn (${orders.length - revenueStats.paidCount})`],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`seg-btn ${ledgerFilter === key ? 'active' : ''}`}
                    aria-pressed={ledgerFilter === key}
                    onClick={() => setLedgerFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="canteen-inline-search">
                <label htmlFor="staff-ledger-search" className="sr-only">
                  Nhập 4 ký tự mã phiếu hoặc tên món
                </label>
                <input
                  id="staff-ledger-search"
                  type="search"
                  placeholder="Tìm mã phiếu #9F42 hoặc món…"
                  value={ledgerSearch}
                  onChange={e => setLedgerSearch(e.target.value)}
                />
              </div>
            </div>
          </div>

          {filteredLedger.length === 0 ? (
            <p className="muted-line">Không tìm thấy đơn nào khớp điều kiện lọc.</p>
          ) : (
            <>
              <div className="ledger-compact-list">
                {pagedLedger.map(order => {
                  const code = ticketCode(order.id);
                  const shownAmount = order.status === 'PAID' && order.paidAmountWei ? order.paidAmountWei : order.totalWei;
                  return (
                    <article key={order.id} className="ledger-compact-row">
                      <div className="ledger-row-summary canteen-ledger-row">
                        <span className="ledger-date tabular-value">{timeShort(order.createdAt)}</span>
                        <div className="ledger-book-cell">
                          <strong>Phiếu #{code} · {summarizeItems(order)}</strong>
                          <span className="ledger-borrower-inline">
                            {order.method === 'FOOD' ? 'Học bổng FOOD' : 'Ví CAMPUS'} · SV {order.payerHint}
                          </span>
                        </div>
                        <span className="canteen-ledger-amount tabular-value">
                          {order.status === 'PAID' ? 'Đã thu ' : 'Tạm tính '}
                          <strong>{formatWalletBalance(BigInt(shownAmount))}</strong>
                        </span>
                        <span
                          className={`network-pill ledger-cash-pill ${
                            order.status === 'PAID' && order.servedAt !== null
                              ? 'pill-ok'
                              : order.status === 'PAID'
                                ? 'pill-warning'
                                : 'pill-danger'
                          }`}
                        >
                          {order.status === 'PAID' && order.servedAt !== null
                            ? `Đã giao (${timeShort(order.servedAt)})`
                            : order.status === 'PAID'
                              ? 'Đã thu · chờ giao'
                              : order.status === 'EXPIRED'
                                ? 'Hết hạn (chưa thu)'
                                : 'SV chưa bấm trả'}
                        </span>
                        {order.status === 'PAID' ? (
                          order.servedAt === null ? (
                            <button
                              type="button"
                              className="primary-cta-btn pagination-btn"
                              disabled={busyId === order.id}
                              onClick={() => onServe(order.id, true)}
                            >
                              ✓ Giao khay
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="secondary-btn pagination-btn"
                              disabled={busyId === order.id}
                              onClick={() => onServe(order.id, false)}
                            >
                              ↶ Hoàn tác
                            </button>
                          )
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>

              <PaginationBar
                total={filteredLedger.length}
                page={safeLedgerPage}
                pageSize={ledgerPageSize}
                onPage={setLedgerPage}
                onPageSize={setLedgerPageSize}
                sizes={[6, 12, 0]}
                unitLabel="đơn hàng"
              />
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
