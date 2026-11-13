"use client";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { browserWalletConfig, campusNetwork, formatWalletBalance } from "../../lib/chains";
import { WalletController, type WalletProvider, type WalletSnapshot } from "../../lib/wallet";
import { InvoicePreview } from "./InvoicePreview";
import GrantPanel from "./GrantPanel";

const WalletContext = createContext<{ state: WalletSnapshot; controller: WalletController } | null>(null);
/** U04/U06 consume this context; readiness does not replace fresh payment preflight. */
export function useCampusWallet() {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useCampusWallet requires WalletSession");
  return wallet;
}
function WalletSubscription({ controller, children }: { controller: WalletController; children: ReactNode }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return <WalletContext.Provider value={{ state, controller }}>{children}</WalletContext.Provider>;
}
function injectedWallet(): WalletProvider | undefined {
  const provider = (window as Window & { ethereum?: Partial<WalletProvider> }).ethereum;
  return provider && typeof provider.request === "function" && typeof provider.on === "function"
    && typeof provider.removeListener === "function" ? provider as WalletProvider : undefined;
}
export function WalletSession({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<WalletController | null>(null);
  useEffect(() => {
    let config;
    try { config = browserWalletConfig(); }
    catch { config = { rpcUrl: "invalid-config" }; }
    const session = new WalletController({ provider: injectedWallet(), config });
    setController(session); void session.start();
    const refresh = () => { if (session.getSnapshot().address) void session.refresh(); };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); session.dispose(); };
  }, []);
  if (!controller) return <section className="surface-panel wallet-initializing" role="status">Đang kiểm tra ví trình duyệt…</section>;
  return <WalletSubscription controller={controller}>{children}</WalletSubscription>;
}
const statusLabels: Record<WalletSnapshot["status"], string> = {
  initializing: "Đang kiểm tra ví…", "no-wallet": "Chưa tìm thấy ví", disconnected: "Chưa kết nối",
  connecting: "Đang chờ ví", rejected: "Đã từ chối kết nối", "wrong-chain": "Sai mạng",
  loading: "Đang đọc dữ liệu", ready: "Đã xác minh dữ liệu", "rpc-error": "Không đọc được dữ liệu",
  "config-missing": "Chưa đủ cấu hình",
};
const cardLabels: Record<WalletSnapshot["card"]["status"], string> = {
  unknown: "Thẻ sinh viên chưa xác minh", none: "Không có thẻ hiện tại",
  valid: "Thẻ sinh viên còn hiệu lực", expired: "Thẻ sinh viên đã hết hạn", inactive: "Thẻ chưa có quyền ưu đãi",
};
function expiryLabel(value: bigint | null) {
  if (value === null || value === BigInt(0)) return "—";
  const date = new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("vi-VN") : `Unix ${value.toString()}`;
}
export function StudentWallet() {
  const { state, controller } = useCampusWallet();
  const connected = state.address !== null;
  const busy = state.status === "connecting" || state.status === "loading";
  const correctChain = state.chainId === BigInt(campusNetwork.chainId);
  return <div className="student-shell live-wallet-view">
    <section className="surface-panel student-identity-panel" aria-labelledby="wallet-title" aria-busy={busy}>
      <div className="panel-top-row">
        <div><h1 id="wallet-title" className="screen-title">Ví sinh viên</h1><p className="screen-subtitle">Kết nối ví để xem số dư và quyền ưu đãi</p></div>
        <span className={`network-pill ${state.status === "wrong-chain" ? "pill-danger" : correctChain ? "pill-ok" : ""}`}>
          <span className="status-dot" aria-hidden="true" />{state.chainId === null ? "Chưa xác định mạng" : correctChain ? campusNetwork.name : `Chain ${state.chainId.toString()}`}
        </span>
      </div>
      <p className="wallet-status" role="status">{statusLabels[state.status]}</p>
      {state.status === "no-wallet" ? <p>Mở trang trong trình duyệt của ví Core hoặc MetaMask, hoặc cài tiện ích ví trên máy tính, rồi tải lại trang.</p> : null}
      {state.status === "rejected" ? <p>Bạn đã từ chối kết nối. Bấm kết nối khi sẵn sàng.</p> : null}
      {state.status === "wrong-chain" ? <p className="wallet-warning">Ví đang ở sai mạng. Hãy chuyển sang IntraCampus L1 · Chain 20261 trước khi tiếp tục.</p> : null}
      {state.message ? <p className="wallet-warning">{state.message}</p> : null}
      <div className="wallet-summary-grid">
        <div className="metric-block"><span className="metric-label">Tài khoản ví</span>
          {connected ? <code className="wallet-address">{state.address}</code> : <strong>Chưa kết nối</strong>}
          {state.accounts.length > 1 ? <label className="wallet-account-picker">Chọn tài khoản đã cấp quyền
            <select value={state.address ?? ""} onChange={(e) => void controller.selectAccount(e.target.value)}>
              {state.accounts.map((account) => <option key={account} value={account}>{account}</option>)}
            </select></label> : null}
          <span className="metric-note">Đổi tài khoản trong ví để dùng ví demo khác.</span>
        </div>
        <div className="metric-block"><span className="metric-label">Số dư CAMPUS</span>
          <strong className="tabular-value wallet-balance">{state.balanceWei === null ? "Chưa đọc được" : formatWalletBalance(state.balanceWei)}</strong>
          <span className="metric-note">{state.balanceWei === null ? "Chưa có số dư đã xác minh" : "Số dư đọc từ RPC · chưa trừ gas"}</span>
        </div>
      </div>
      <div className={`sbt-banner ${state.card.status === "valid" ? "sbt-active" : "sbt-muted"}`}>
        <div className="sbt-banner-head"><strong>{cardLabels[state.card.status]}</strong>
          <span className="sbt-badge">{state.card.tier === null ? "Chưa xác minh tier" : `Tier ${state.card.tier}`}</span>
        </div>
        <p>{state.card.tier === 1 ? "Đủ điều kiện ưu đãi sinh viên. Giá cuối sẽ được kiểm tra khi thanh toán."
          : state.card.tier === 0 ? "Hiện không có quyền ưu đãi sinh viên." : "Chưa thể kết luận quyền ưu đãi của tài khoản này."}</p>
        {state.card.tokenId !== null && state.card.tokenId > BigInt(0) ? <span className="sbt-meta">Thẻ #{state.card.tokenId.toString()} · Hạn: {expiryLabel(state.card.expiresAt)}</span> : null}
      </div>
      <div className="inline-actions wallet-actions">
        {!connected && state.status !== "no-wallet" ? <button type="button" className="primary-cta-btn" disabled={busy} onClick={() => void controller.connect()}>{busy ? "Đang chờ ví…" : "Kết nối ví"}</button> : null}
        {connected && !correctChain ? <button type="button" className="primary-cta-btn" disabled={busy} onClick={() => void controller.switchNetwork()}>Chuyển sang IntraCampus L1</button> : null}
        {connected ? <><button type="button" className="secondary-btn" disabled={busy} onClick={() => void controller.refresh()}>Thử đọc lại</button>
          <button type="button" className="secondary-btn" onClick={() => controller.disconnect()}>Ngắt kết nối</button></> : null}
        {state.status === "no-wallet" ? <button type="button" className="secondary-btn" onClick={() => window.location.reload()}>Kiểm tra lại ví</button> : null}
      </div>
    </section>
    <section className="surface-panel wallet-payment-gate" aria-labelledby="payment-gate-title">
      <h2 id="payment-gate-title">Thanh toán bằng QR</h2>
      <p>{state.canProceed ? "Ví Core đã sẵn sàng. Quét hoặc dán hóa đơn để xem trước số CAMPUS cần trả." : "Kết nối ví Core trên chain 20261 để xác minh hóa đơn và ưu đãi."}</p>
      <InvoicePreview wallet={state} />
    </section>
    <GrantPanel />
    <p className="wallet-live-note">Dữ liệu được đọc từ mạng đã cấu hình. Bạn chỉ yêu cầu giao dịch khi bấm thanh toán hoặc chi FOOD và xác nhận trong Core.</p>
  </div>;
}
