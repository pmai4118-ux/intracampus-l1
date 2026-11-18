'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
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
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/canteen/${path}`, { cache: 'no-store', credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.code ?? 'SERVICE_UNAVAILABLE');
  return data;
}
const labels: Record<string,string> = { RPC_UNAVAILABLE: 'Chưa kết nối được mạng. Giữ hash cũ và thử đối chiếu lại.', SERVICE_UNAVAILABLE: 'Chưa đọc được dịch vụ nhà ăn. Thử lại sau.', WRONG_CHAIN: 'Chuyển ví sang IntraCampus L1, chain 20261.', DISH_UNAVAILABLE: 'Món đã chọn hiện không có trong thực đơn. Hãy tải lại thực đơn.', FORBIDDEN: 'Phiên ví không có quyền thực hiện thao tác này.', IDEMPOTENCY_CONFLICT: 'Lượt tạo đơn cũ có nội dung khác. Khôi phục đơn chưa rõ kết quả trước.', INVOICE_EXPIRED: 'Hóa đơn đã hết hạn. Giữ đơn cũ trong lịch sử và tạo đơn mới; không gửi lại giao dịch chưa rõ kết quả.', INVOICE_ALREADY_PAID: 'Hóa đơn đã trả trên chain. Mở lại đơn để đối chiếu; không trả thêm.', UNAUTHENTICATED: 'Hãy đăng nhập bằng ví sinh viên.', ACCOUNT_HELD: 'Tài khoản đang bị giữ. Xử lý khoản mượn thư viện trước khi đặt món.', INSUFFICIENT_FOOD: 'Học bổng FOOD không đủ cho đơn này.', STALE_CHAIN_STATE: 'Mạng chưa có block mới. Thử lại khi RPC hoạt động.', CONFIGURATION_ERROR: 'Chưa cấu hình mạng và căn-tin.', RECEIPT_MISMATCH: 'Giao dịch không khớp đơn. Giữ hash để đối chiếu.', PAYMENT_ALREADY_USED: 'Giao dịch này đã gắn với đơn khác.' };
export default function CanteenSession() { return <WalletSession><Canteen /></WalletSession>; }
function Canteen() {
  const { state: wallet, controller } = useCampusWallet();
  return <div className="library-shell canteen-shell"><PageHeading eyebrow="BỮA NGON GIỮA NGÀY" title="Hẹn nhau ở nhà ăn." description="Chọn món hôm nay, thanh toán bằng CAMPUS hoặc học bổng FOOD." icon="utensils"><Link className="secondary-btn" href="/student">Về ví sinh viên</Link></PageHeading>
    <LibraryWalletSummary /><Workspace key={`${wallet.address}:${wallet.chainId}`} wallet={wallet.address} sign={(account,message)=>controller.signMessage(account,message)} /></div>;
}
function Workspace({ wallet, sign }: { wallet: string | null; sign: (account: string,message: string)=>Promise<string> }) {
  const [dishes,setDishes] = useState<CanteenDish[]>([]), [cart,setCart] = useState<Record<string,number>>({}), [orders,setOrders] = useState<CanteenOrder[]>([]);
  const [method,setMethod] = useState<'WALLET'|'FOOD'>('WALLET'), [active,setActive] = useState<CanteenOrder | null>(null), [preview,setPreview] = useState<InvoicePreview | null>(null);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [signed,setSigned] = useState(false);
  const activeOrderId = useRef<string | null>(null);
  const [pendingCreate,setPendingCreate] = useState(false);
  const [menuLoading, setMenuLoading] = useState(true), [menuError, setMenuError] = useState(false), [menuVersion, setMenuVersion] = useState(0);
  useEffect(()=>{try{setPendingCreate(!!localStorage.getItem(`intracampus.canteen.create:${wallet}`));}catch{setError('Không đọc được bộ nhớ đơn hàng.');}},[wallet]);
  const total = dishes.reduce((n,d)=>n+BigInt(d.priceWei)*BigInt(cart[d.id] ?? 0),BigInt(0));
  const selectedDishes = dishes.filter(dish => (cart[dish.id] ?? 0) > 0);
  function setQuantity(id: string, quantity: number) {
    if (Number.isSafeInteger(quantity) && quantity >= 0) setCart(previous => ({ ...previous, [id]: quantity }));
  }
  const run = async (work: ()=>Promise<void>) => { if(busy) return; setBusy(true); setError(''); try { await work(); } catch(e) { const code=e instanceof Error?e.message:'SERVICE_UNAVAILABLE'; setError(labels[code] ?? code); } finally {setBusy(false);} };
  useEffect(() => {
    let live = true;
    setMenuLoading(true); setMenuError(false);
    void api('menu').then(data => { if (live) setDishes(data.dishes); })
      .catch(() => { if (live) setMenuError(true); })
      .finally(() => { if (live) setMenuLoading(false); });
    return () => { live = false; };
  }, [menuVersion]);
  const track = useCallback(async (hash: string) => {
    if(!active) return;
    const updated: CanteenOrder = await api(`orders/${active.id}/transactions`,{txHash:hash});
    setOrders(old=>old.map(o=>o.id===updated.id?updated:o));
    if (activeOrderId.current === updated.id) setActive(updated);
    return updated;
  },[active?.id]);
  const paid = useCallback((hash: string)=>{ void track(hash).catch(e=>setError(labels[e.message] ?? e.message)); },[track]);
  async function open(order: CanteenOrder) {
    activeOrderId.current = order.id;
    setActive(order); setPreview(null);
    if(order.status==='PAID') return;
    if(order.txHash) {const updated=await api(`orders/${order.id}/transactions`,{txHash:order.txHash});setActive(updated);if(updated.status==='PAID')return;}
    const data=await api(`orders/${order.id}/prepare`,{});setActive(data.order);setOrders(old=>old.map(o=>o.id===data.order.id?data.order:o));if(data.order.status==='PAID'||data.order.status==='EXPIRED')return;
    if(data.envelope && wallet) {const config=browserWalletConfig();if(!config.rpcUrl)throw Error('CONFIGURATION_ERROR');setPreview(await verifyInvoicePreview(JSON.stringify(data.envelope),wallet,config,createWalletRpc(config.rpcUrl)));}
  }
  return <div className="canteen-workspace">
    <section className="surface-panel canteen-menu-panel" aria-labelledby="canteen-menu-title" aria-busy={menuLoading}>
      <div className="canteen-menu-heading"><div><span className="panel-eyebrow">CAMPUS KITCHEN</span><h2 id="canteen-menu-title">Hôm nay ăn gì?</h2><p>Một bữa ngon để tiếp tục những điều hay.</p></div><span className="canteen-demo-badge">Thực đơn & giá demo</span></div>
      {menuLoading ? <div className="canteen-menu-loading" role="status"><span className="spinner" aria-hidden="true" />Đang chuẩn bị thực đơn…</div>
        : menuError ? <div className="canteen-empty-state" role="alert"><Icon name="bowl" /><h3>Chưa tải được thực đơn</h3><p>Kiểm tra kết nối và thử lại để chọn món.</p><button type="button" className="secondary-btn" onClick={() => setMenuVersion(version => version + 1)}>Tải lại thực đơn</button></div>
        : dishes.length === 0 ? <div className="canteen-empty-state"><Icon name="bowl" /><h3>Thực đơn đang cập nhật</h3><p>Chưa có món để đặt. Bạn có thể quay lại sau.</p></div>
        : <div className="canteen-menu">{dishes.map((dish, index) => <article key={dish.id} className={`canteen-dish dish-tone-${index % 3} ${(cart[dish.id] ?? 0) > 0 ? 'dish-selected' : ''}`}>
          <div className="canteen-dish-visual" aria-hidden="true"><span className="dish-number">0{index + 1}</span><Icon name="bowl" /><span className="dish-visual-caption">FRESH CAMPUS MOMENTS</span></div>
          <div className="canteen-dish-content"><h3>{dish.name}</h3><p>{dish.description}</p><strong>{formatWalletBalance(BigInt(dish.priceWei))}</strong></div>
          <div className="canteen-quantity"><label htmlFor={`dish-quantity-${dish.id}`}>Số lượng {dish.name}</label><div className="quantity-stepper">
            <button type="button" aria-label={`Giảm số lượng ${dish.name}`} disabled={busy || !(cart[dish.id] ?? 0)} onClick={() => setQuantity(dish.id, (cart[dish.id] ?? 0) - 1)}>−</button>
            <input id={`dish-quantity-${dish.id}`} type="number" inputMode="numeric" min="0" step="1" disabled={busy} value={cart[dish.id] ?? 0} onChange={event => setQuantity(dish.id, Number(event.target.value))} />
            <button type="button" aria-label={`Tăng số lượng ${dish.name}`} disabled={busy || !Number.isSafeInteger((cart[dish.id] ?? 0) + 1)} onClick={() => setQuantity(dish.id, (cart[dish.id] ?? 0) + 1)}>+</button>
          </div></div>
        </article>)}</div>}
      <div className="canteen-menu-note"><Icon name="shield" /><span>Giá và ưu đãi được đối chiếu trước khi bạn xác nhận trong ví.</span></div>
    </section>
    <section className="surface-panel canteen-cart" aria-labelledby="canteen-cart-title">
      <div className="panel-heading-with-icon"><span className="panel-icon icon-gold"><Icon name="utensils" /></span><div><span className="panel-eyebrow">BỮA ĂN CỦA BẠN</span><h2 id="canteen-cart-title">Đơn của bạn</h2></div><span className="canteen-cart-count">{selectedDishes.length} món</span></div>
      {selectedDishes.length ? <ul className="canteen-cart-items">{selectedDishes.map(dish => <li key={dish.id}><span>{dish.name}<small>× {cart[dish.id]}</small></span><strong>{formatWalletBalance(BigInt(dish.priceWei) * BigInt(cart[dish.id]))}</strong></li>)}</ul>
        : <div className="canteen-cart-empty"><Icon name="bowl" /><p>Chọn một món ngon để bắt đầu.</p></div>}
      <div className="canteen-cart-total" aria-live="polite"><span>Tổng giá món</span><strong>{formatWalletBalance(total)}</strong></div>
      <label className="canteen-payment-label" htmlFor="canteen-payment-method">Nguồn thanh toán</label><select id="canteen-payment-method" value={method} onChange={e=>setMethod(e.target.value as typeof method)}><option value="WALLET">CAMPUS trong ví</option><option value="FOOD">Học bổng FOOD</option></select>
      <p className="canteen-payment-note">{method==='WALLET'?'Ví hưởng ưu đãi SBT hiện tại; xem số thực trả trước khi ký.':'FOOD chi đúng tổng món; gas trả bằng CAMPUS trong ví.'}</p>
      <div className="canteen-cart-actions">
      {!signed?<button className="secondary-btn" disabled={busy||!wallet} onClick={()=>void run(async()=>{await signInLibraryStudent(wallet!,sign);setSigned(true);setOrders((await api('orders')).orders);})}>Đăng nhập bằng ví sinh viên</button>:<button className="secondary-btn" disabled={busy} onClick={()=>void run(async()=>setOrders((await api('orders')).orders))}>Làm mới danh sách đơn</button>}
      {pendingCreate ? <button className="secondary-btn" disabled={busy||!signed} onClick={()=>void run(async()=>{
        const key=`intracampus.canteen.create:${wallet}`, saved=localStorage.getItem(key);
        if(!saved) {setPendingCreate(false);return;}
        const entry=JSON.parse(saved), payload=JSON.parse(entry.payload);
        const order=await api('orders',{...payload,idempotencyKey:entry.key});localStorage.removeItem(key);setPendingCreate(false);
        setOrders(old=>[order,...old.filter(o=>o.id!==order.id)]);await open(order);
      })}>Khôi phục đơn chưa rõ kết quả</button> : null}
      <button className="primary-cta-btn" disabled={busy||!signed||total===BigInt(0)} onClick={()=>void run(async()=>{
        const key=`intracampus.canteen.create:${wallet}`;let saved=localStorage.getItem(key);
        const items=dishes.filter(d=>(cart[d.id]??0)>0).map(d=>({dishId:d.id,quantity:cart[d.id]}));
        const payload=JSON.stringify({method,items});let entry=saved?JSON.parse(saved):null;
        if(entry&&entry.payload!==payload)throw Error('Đơn trước chưa rõ kết quả. Giữ giỏ hàng và thử lại.');
        if(!entry){entry={payload,key:crypto.randomUUID()};localStorage.setItem(key,JSON.stringify(entry));setPendingCreate(true);}
        const order=await api('orders',{method,items,idempotencyKey:entry.key});localStorage.removeItem(key);setPendingCreate(false);setOrders(old=>[order,...old.filter(o=>o.id!==order.id)]);setCart({});await open(order);
      })}>Tạo đơn và xem thanh toán</button>
      </div>
      {!signed ? <p className="canteen-sign-in-hint"><Icon name="shield" />Đăng nhập bằng ví trước khi tạo đơn.</p> : null}
      {busy?<p role="status">Đang xử lý…</p>:null}{error?<p className="error-panel" role="alert">{error}</p>:null}
    </section>
    {active?<section className="surface-panel canteen-active-order"><span className="panel-eyebrow">CHI TIẾT & THANH TOÁN</span><h2>Đơn {active.id.slice(0,8)}</h2><ul>{active.items.map(i=><li key={i.dishId}>{i.name} × {i.quantity} · {formatWalletBalance(BigInt(i.unitPriceWei)*BigInt(i.quantity))}</li>)}</ul>
      <p>{active.status==='PAID'?'Đã thanh toán, receipt đã xác minh':active.status==='EXPIRED'?'Hóa đơn hết hạn':'Chờ thanh toán'} · {active.method==='FOOD'?'Học bổng FOOD':'CAMPUS trong ví'}</p>
      {active.txHash?<code className="tx-hash-code">{active.txHash}</code>:null}
      {active.status==='PAID'?<><strong>Đã trả {formatWalletBalance(BigInt(active.paidAmountWei!))}</strong>{active.method==='FOOD'?<p>Nếu ví còn lượt FOOD đã xác minh, mở <Link href="/student#grant-title">Học bổng FOOD</Link> và đóng lượt đã xong trước khi chi đơn tiếp theo.</p>:null}</>:active.status==='EXPIRED'?<p>Đơn đã hết hạn. Nếu chưa gửi giao dịch, chọn món và tạo đơn mới. Nếu đã yêu cầu ví ký, mở đơn để đối chiếu trước khi trả thêm.<button className="secondary-btn" disabled={busy} onClick={()=>void run(()=>open(active))}>Đối chiếu đơn cũ</button></p>:active.method==='FOOD'&&active.afterBlock!==null?<CanteenFood order={active} onHash={track}/>:preview?<PayInvoice preview={preview} onPaid={paid}/>:<button className="secondary-btn" disabled={busy} onClick={()=>void run(()=>open(active))}>Mở thanh toán / đối chiếu đơn</button>}
    </section>:null}
    <section className="surface-panel canteen-history"><div className="panel-heading-with-icon"><span className="panel-icon"><Icon name="clock" /></span><div><span className="panel-eyebrow">NHỮNG BỮA ĂN ĐÃ ĐẶT</span><h2>Lịch sử đơn</h2></div></div>{orders.length===0?<p>Đăng nhập để xem đơn đã tạo.</p>:<ul>{orders.map(o=><li key={o.id}><button className="secondary-btn" disabled={busy} onClick={()=>void run(()=>open(o))}>{o.id.slice(0,8)} · {formatWalletBalance(BigInt(o.totalWei))} · {o.status==='PAID'?'Đã thanh toán':o.status==='EXPIRED'?'Hết hạn':'Chờ thanh toán'}</button></li>)}</ul>}</section>
  </div>;
}
