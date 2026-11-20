'use client';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { GrantController, grantConfig, grantMessage } from '../../../lib/grants';
import { browserWalletConfig, formatWalletBalance } from '../../../lib/chains';
import { createWalletRpc } from '../../../lib/wallet';
import { requireLibraryStudentNotHeld } from '../../../lib/library-session';
import { useCampusWallet } from '../WalletPanel';
import HashChip from '../../components/HashChip';
import TransactionStepper, { type StepState } from '../../components/TransactionStepper';
import type { CanteenOrder } from '@intracampus/network';

function foodStep(phase: string, matched: boolean): StepState {
  if (!matched) return 'idle';
  if (phase === 'checking') return 'checking';
  if (phase === 'signing') return 'signing';
  if (phase === 'pending' || phase === 'unknown') return 'confirming';
  if (phase === 'confirmed') return 'done';
  if (phase === 'reverted') return 'error';
  return 'idle';
}
export default function CanteenFood({ order, onHash }: { order: CanteenOrder; onHash: (hash: string) => Promise<CanteenOrder | undefined> }) {
  const { controller: wallet, state } = useCampusWallet();
  const [destination,setDestination] = useState<{ merchant: string; vault: string } | null>(null);
  const [controller,setController] = useState<GrantController | null>(null), [error,setError] = useState('');
  useEffect(() => {
    let session: GrantController | undefined;
    try {
      const url = browserWalletConfig().rpcUrl;
      if (!url) throw Error('RPC_UNAVAILABLE');
      setDestination(grantConfig());
      session = new GrantController({ orderId: order.id, config: grantConfig(), rpc: createWalletRpc(url), wallet,
        storage: window.localStorage, accountGuard: requireLibraryStudentNotHeld });
      setController(session); void session.bindWallet(state.address);
    } catch(e) { setError(grantMessage(e instanceof Error ? e.message : 'RPC_UNAVAILABLE')); }
    return () => session?.dispose();
  },[order.id,wallet,state.address]);
  return <>{destination ? <dl className="library-details"><dt>Mạng</dt><dd>IntraCampus L1 · 20261</dd><dt>Căn-tin nhận</dt><dd><HashChip value={destination.merchant} copyLabel="Sao chép địa chỉ căn-tin" /></dd><dt>Vault FOOD</dt><dd><HashChip value={destination.vault} copyLabel="Sao chép địa chỉ vault FOOD" /></dd></dl> : null}{error ? <p role="alert">{error}</p> : controller ? <FoodView controller={controller} order={order} onHash={onHash} /> : <p role="status">Đang đọc học bổng FOOD…</p>}</>;
}
function FoodView({ controller, order, onHash }: { controller: GrantController; order: CanteenOrder; onHash: (hash: string) => Promise<CanteenOrder | undefined> }) {
  const snapshot = useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
  const [hash,setHash] = useState(''), [error,setError] = useState('');
  const matches = snapshot.intent?.orderId === order.id;
  useEffect(() => {
    if (!matches || !snapshot.intent?.hash) return;
    let active = true;
    const reconcile = () => { void onHash(snapshot.intent!.hash!).then(async updated => {
      if(updated?.status === 'PAID' && controller.getSnapshot().phase === 'confirmed') await controller.newSpend();
    }).catch(e => { if(active) setError(e.message); }); };
    reconcile(); const timer = setInterval(reconcile,5000);
    return () => { active=false; clearInterval(timer); };
  },[snapshot.intent?.hash,matches,onHash]);
  return <div>
    <TransactionStepper state={foodStep(snapshot.phase, matches || snapshot.phase === 'checking' || snapshot.phase === 'signing')} />
    <p>Ngân sách FOOD: <strong>{snapshot.lookup ? formatWalletBalance(BigInt(snapshot.lookup.balanceWei)) : 'Chưa xác minh'}</strong></p>
    <p>Chi <strong>{formatWalletBalance(BigInt(order.totalWei))}</strong> tại căn-tin. Phí gas trả từ CAMPUS trong ví.</p>
    {snapshot.intent && !matches ? <p role="alert">Ví có lượt chi FOOD khác. Về mục Học bổng FOOD để đối chiếu và đóng lượt đó trước.</p> : null}
    <div className="inline-actions">
      <button className="primary-cta-btn" disabled={snapshot.busy || !!order.txHash || !!snapshot.intent || !snapshot.lookup?.allowed || BigInt(snapshot.lookup?.balanceWei ?? '0') < BigInt(order.totalWei)} onClick={() => void controller.spend(BigInt(order.totalWei))}>Xác nhận chi FOOD bằng ví</button>
      <button className="secondary-btn" disabled={snapshot.busy} onClick={() => void controller.refresh()}>Đọc lại FOOD</button>
    </div>
    {snapshot.message ? <p role="status">{snapshot.message}</p> : null}
    {snapshot.intent?.hash ? <p className="metric-note">Mã giao dịch FOOD: <HashChip value={snapshot.intent.hash} start={10} end={8} copyLabel="Sao chép mã giao dịch FOOD" /></p> : null}
    {matches && snapshot.phase === 'prepared' ? <button className="secondary-btn" onClick={() => void controller.reconcilePrepared()}>Khôi phục lượt chưa gửi</button> : null}
    {matches && snapshot.phase === 'unknown' ? <form onSubmit={e => {e.preventDefault(); void controller.recoverHash(hash.trim());}}>
      <label>Hash từ lịch sử ví<input className="mono-textarea" value={hash} onChange={e=>setHash(e.target.value)} /></label><button className="secondary-btn">Đối chiếu giao dịch đã gửi</button></form> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
