"use client";
import { CAMPUS_CHAIN_ID } from "@intracampus/network";

import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { browserWalletConfig, campusNetwork, formatWalletBalanceCompact } from "../../lib/chains";
import { LibrarySessionError, readLibraryStudentAccess, signInLibraryStudent, type LibraryStudentAccess } from "../../lib/library-session";
import { WalletController, selectInjectedWallet, type WalletSnapshot } from "../../lib/wallet";
import { InvoicePreview } from "./InvoicePreview";
import GrantPanel from "./GrantPanel";
import StudentParkingTickets from "./StudentParkingTickets";
import Icon from "../components/Icon";

const WalletContext = createContext<{
  state: WalletSnapshot;
  controller: WalletController;
  access: LibraryStudentAccess | null;
  signingIn: boolean;
  signIn: () => Promise<void>;
  refreshAccess: () => Promise<void>;
} | null>(null);
/** U04/U06 consume this context; readiness does not replace fresh payment preflight. */
export function useCampusWallet() {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useCampusWallet requires WalletSession");
  return wallet;
}
function WalletSubscription({ controller, children }: { controller: WalletController; children: ReactNode }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [access, setAccess] = useState<LibraryStudentAccess | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    let active = true;
    setAccess(null);
    if (!state.address) return () => { active = false; };
    void readLibraryStudentAccess(state.address).then((result) => { if (active) setAccess(result); });
    return () => { active = false; };
  }, [state.address]);
  const signIn = useCallback(async () => {
    if (!state.address || signingIn) return;
    setSigningIn(true);
    try {
      const result = await signInLibraryStudent(state.address, (account, message) => controller.signMessage(account, message));
      setAccess(result);
    } catch (cause) {
      setAccess({ status: "error", code: cause instanceof LibrarySessionError ? cause.code : "SESSION_UNAVAILABLE", blockingLoanIds: [] });
    } finally {
      setSigningIn(false);
    }
  }, [state.address, signingIn, controller]);
  const refreshAccess = useCallback(async () => {
    if (!state.address) return;
    setAccess(await readLibraryStudentAccess(state.address));
  }, [state.address]);
  return <WalletContext.Provider value={{ state, controller, access, signingIn, signIn, refreshAccess }}>{children}</WalletContext.Provider>;
}
export function WalletSession({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<WalletController | null>(null);
  useEffect(() => {
    let config;
    try { config = browserWalletConfig(); }
    catch { config = { rpcUrl: "invalid-config" }; }
    const session = new WalletController({ provider: selectInjectedWallet(window as Window & { avalanche?: unknown; ethereum?: unknown }), config });
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
export function StudentWallet({ onOpenDemo }: { onOpenDemo?: () => void } = {}) {
  const { state, controller } = useCampusWallet();
  const [addressCopied, setAddressCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<"all" | "qr" | "food" | "parking">("all");
  const [parkingTicketCount, setParkingTicketCount] = useState(0);
  const connected = state.address !== null;
  const busy = state.status === "connecting" || state.status === "loading";
  const correctChain = state.chainId === BigInt(campusNetwork.chainId);
  const compactBalance = state.balanceWei === null ? null : formatWalletBalanceCompact(state.balanceWei, 2);
  useEffect(() => {
    if (!addressCopied) return;
    const timer = window.setTimeout(() => setAddressCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [addressCopied]);
  useEffect(() => {
    if (!state.address) setParkingTicketCount(0);
  }, [state.address]);
  useEffect(() => {
    const syncHash = () => {
      const hash = window.location.hash;
      if (hash === "#payment-gate-title") {
        setActiveTab((prev) => (prev === "all" || prev === "qr" ? prev : "qr"));
      } else if (hash === "#grant-title") {
        setActiveTab((prev) => (prev === "all" || prev === "food" ? prev : "food"));
      } else if (hash === "#parking-tickets") {
        setActiveTab((prev) => (prev === "all" || prev === "parking" ? prev : "parking"));
      }
      if (hash === "#payment-gate-title" || hash === "#grant-title" || hash === "#parking-tickets") {
        window.requestAnimationFrame(() => {
          document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    };
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);
  const showQr = activeTab === "all" || activeTab === "qr";
  const showFood = activeTab === "all" || activeTab === "food";
  const showParking = activeTab === "all" || activeTab === "parking";
  return <div className="student-shell live-wallet-view">
    <div className="student-identity-column"><section className="surface-panel student-identity-panel" aria-labelledby="wallet-title" aria-busy={busy}>
      <div className="panel-top-row">
        <div><span className="panel-eyebrow">CAMPUS WALLET</span><h2 id="wallet-title" className="screen-title">Ví sinh viên</h2><p className="screen-subtitle">Số dư và quyền ưu đãi của bạn</p></div>
        <span className={`network-pill ${state.status === "wrong-chain" ? "pill-danger" : correctChain ? "pill-ok" : ""}`}>
          <span className="status-dot" aria-hidden="true" />{state.chainId === null ? "Chưa xác định mạng" : correctChain ? campusNetwork.name : `Chain ${state.chainId.toString()}`}
        </span>
      </div>
      <div className="campus-live-pass" aria-hidden="true">
        <div className="live-pass-top">
          <span className="live-pass-brand"><Icon name="graduation" />IntraCampus Pass</span>
          <span className="live-pass-chain">{correctChain ? `L1 · ${CAMPUS_CHAIN_ID}` : `CHỜ MẠNG ${CAMPUS_CHAIN_ID}`}</span>
        </div>
        <div className="live-pass-body">
          <div className="pass-chip"><i /><i /><i /></div>
          <div className="live-pass-identity">
            <span className="live-pass-kicker">{state.card.tier === 1 ? "THẺ SINH VIÊN SBT · ƯU ĐÃI -10%" : state.card.tier === 0 ? "TÀI KHOẢN TIÊU CHUẨN · GIÁ GỐC" : "CHƯA XÁC MINH QUYỀN THẺ"}</span>
            <strong>{connected && state.address ? `${state.address.slice(0, 6)}…${state.address.slice(-4)}` : "CHƯA KẾT NỐI VÍ"}</strong>
          </div>
          <Icon name="leaf" className="live-pass-leaf" />
        </div>
        <div className="live-pass-bottom">
          <span>{state.card.tokenId !== null && state.card.tokenId > BigInt(0) ? `PASS #${state.card.tokenId.toString().padStart(4, "0")}` : "CHƯA CẤP MÃ THẺ"}</span>
          <span>{state.card.expiresAt !== null && state.card.expiresAt > BigInt(0) ? `HẠN ${expiryLabel(state.card.expiresAt)}` : "INTRACAMPUS L1"}</span>
        </div>
      </div>
      <div className="wallet-balance-hero">
        <div className="wallet-balance-hero-head">
          <span className="metric-label">Số dư CAMPUS</span>
          <span className="wallet-status wallet-status-pill" role="status">{statusLabels[state.status]}</span>
        </div>
        <strong
          className="tabular-value wallet-balance wallet-balance-hero-amount"
          title={compactBalance ? `Số dư chính xác: ${compactBalance.exact}` : undefined}
        >
          {compactBalance === null ? "Chưa đọc được" : compactBalance.display}
        </strong>
        {compactBalance?.rounded ? (
          <details className="exact-balance-disclosure">
            <summary>Xem số chính xác</summary>
            <code className="mono-value" translate="no">{compactBalance.exact}</code>
          </details>
        ) : (
          <span className="metric-note">{compactBalance === null ? "Chưa có số dư đã xác minh" : "Số dư đọc từ RPC · chưa trừ gas"}</span>
        )}
      </div>
      {state.status === "no-wallet" ? <p>Mở trang trong trình duyệt của ví Core hoặc MetaMask, hoặc cài tiện ích ví trên máy tính, rồi tải lại trang.</p> : null}
      {state.status === "rejected" ? <p>Bạn đã từ chối kết nối. Bấm kết nối khi sẵn sàng.</p> : null}
      {state.status === "wrong-chain" ? <p className="wallet-warning">Ví đang ở sai mạng. Hãy chuyển sang IntraCampus L1 · Chain {CAMPUS_CHAIN_ID} trước khi tiếp tục.</p> : null}
      {state.message ? <p className="wallet-warning">{state.message}</p> : null}
      <div className="wallet-summary-grid wallet-summary-compact">
        <div className="metric-block metric-block-wide">
          <span className="metric-label">Tài khoản ví</span>
          {connected && state.address ? (
            <div className="wallet-address-row">
              <code className="wallet-address" translate="no">{state.address}</code>
              <button
                type="button"
                className={`hash-chip-btn hash-copy-icon-btn ${addressCopied ? "is-copied" : ""}`}
                aria-label={`Sao chép địa chỉ ví: ${state.address}`}
                title={addressCopied ? "Đã chép" : "Sao chép địa chỉ ví"}
                onClick={() => {
                  void navigator.clipboard.writeText(state.address!).then(() => setAddressCopied(true)).catch(() => {});
                }}
              >
                <Icon name={addressCopied ? "check" : "copy"} />
                {addressCopied ? <span>Đã chép</span> : null}
              </button>
            </div>
          ) : <strong>Chưa kết nối</strong>}
          {state.accounts.length > 1 ? <label className="wallet-account-picker">Chọn tài khoản đã cấp quyền
            <select value={state.address ?? ""} onChange={(e) => void controller.selectAccount(e.target.value)}>
              {state.accounts.map((account) => <option key={account} value={account}>{account}</option>)}
            </select></label> : null}
          <span className="metric-note">Đổi tài khoản trong ví để dùng ví demo khác.</span>
        </div>
        <div className="metric-block metric-block-wide">
          <span className="metric-label">Mức ưu đãi hiện tại</span>
          <strong>{state.card.tier === 1 ? "Giảm 10% tự động" : state.card.tier === 0 ? "Giá niêm yết (0%)" : "Chưa xác định"}</strong>
          <span className="metric-note">{state.card.tier === 1 ? "Áp dụng cho bãi xe & nhà ăn" : state.card.tier === 0 ? "Cần thẻ SBT còn hạn để giảm 10%" : `Kết nối mạng ${CAMPUS_CHAIN_ID} để tra cứu`}</span>
        </div>
      </div>
      <div className={`sbt-banner ${state.card.status === "valid" ? "sbt-active" : "sbt-muted"}`}>
        <div className="sbt-banner-head"><strong>{cardLabels[state.card.status]}</strong>
          <span className="sbt-badge">{state.card.tier === null ? "Chưa xác minh tier" : `Tier ${state.card.tier}`}</span>
        </div>
        <p>{state.card.tier === 1 ? "Đủ điều kiện ưu đãi sinh viên. Giá cuối sẽ được kiểm tra khi thanh toán."
          : state.card.tier === 0 ? "Hiện không có quyền ưu đãi sinh viên." : "Chưa thể kết luận quyền ưu đãi của tài khoản này."}</p>
        {state.card.tokenId !== null && state.card.tokenId > BigInt(0) ? <span className="sbt-meta">Thẻ #{state.card.tokenId.toString()} · Hạn: {expiryLabel(state.card.expiresAt)}</span> : null}
        {state.card.tier === 0 ? (
          <div className="sbt-tier0-guidance">
            {onOpenDemo ? (
              <button type="button" className="link-action-btn" onClick={onOpenDemo}>
                Xem thử ưu đãi thẻ SBT (-10%) ở bản minh họa →
              </button>
            ) : null}
            <details className="sbt-mint-guide">
              <summary>Làm sao để nhận thẻ sinh viên SBT demo?</summary>
              <p>Chuyển sang ví sinh viên đã cấp thẻ trong Core, hoặc nhờ quản trị viên chạy lệnh cấp thẻ demo cho địa chỉ ví này (<code>pnpm --filter @intracampus/backend seed:demo</code>).</p>
            </details>
          </div>
        ) : null}
      </div>
      <div className="inline-actions wallet-actions">
        {!connected && state.status !== "no-wallet" ? <button type="button" className="primary-cta-btn" disabled={busy} onClick={() => void controller.connect()}>{busy ? "Đang chờ ví…" : "Kết nối ví"}</button> : null}
        {connected && !correctChain ? <button type="button" className="primary-cta-btn" disabled={busy} onClick={() => void controller.switchNetwork()}>Chuyển sang IntraCampus L1</button> : null}
        {connected ? <><button type="button" className="secondary-btn" disabled={busy} onClick={() => void controller.refresh()}>Thử đọc lại</button>
          <button type="button" className="secondary-btn" onClick={() => controller.disconnect()}>Ngắt kết nối</button></> : null}
        {state.status === "no-wallet" ? <button type="button" className="secondary-btn" onClick={() => window.location.reload()}>Kiểm tra lại ví</button> : null}
      </div>
    </section></div>
    <div className="student-services-column">
      <div className="student-tab-bar" role="group" aria-label="Lọc tiện ích sinh viên">
        {([
          ["all", "Tất cả"],
          ["qr", "Quét QR"],
          ["food", "Học bổng FOOD"],
          ["parking", parkingTicketCount > 0 ? `Vé gửi xe (${parkingTicketCount})` : "Vé gửi xe"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`seg-btn ${activeTab === key ? "active" : ""}`}
            aria-pressed={activeTab === key}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="surface-panel wallet-payment-gate" aria-labelledby="payment-gate-title" hidden={!showQr}>
        <div className="panel-heading-with-icon"><span className="panel-icon"><Icon name="qr" /></span><div><span className="panel-eyebrow">QUÉT & THANH TOÁN</span><h2 id="payment-gate-title">Thanh toán bằng QR</h2></div><span className="step-label">01 / 03</span></div>
        <p>{state.canProceed ? "Ví Core đã sẵn sàng. Quét hoặc dán hóa đơn để xem trước số CAMPUS cần trả." : `Kết nối ví Core trên chain ${CAMPUS_CHAIN_ID} để xác minh hóa đơn và ưu đãi.`}</p>
        <InvoicePreview wallet={state} />
      </section>
      <div className="student-panel-slot" hidden={!showFood}>
        <GrantPanel />
      </div>
      <StudentParkingTickets hidden={!showParking} onCountChange={setParkingTicketCount} />
    </div>
    <p className="wallet-live-note">Dữ liệu được đọc từ mạng đã cấu hình. Bạn chỉ yêu cầu giao dịch khi bấm thanh toán hoặc chi FOOD và xác nhận trong Core.</p>
  </div>;
}
