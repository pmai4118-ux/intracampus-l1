"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { browserWalletConfig, formatWalletBalance } from "../../lib/chains";
import { createWalletRpc } from "../../lib/wallet";
import { GrantController, grantConfig, grantMessage, parseGrantAmount, type GrantConfig } from "../../lib/grants";
import { useCampusWallet } from "./WalletPanel";

function GrantView({ controller, config }: { controller: GrantController; config: GrantConfig }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { state: wallet } = useCampusWallet();
  const [amount, setAmount] = useState("1000"), [recoveryHash, setRecoveryHash] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  useEffect(() => { void controller.bindWallet(wallet.address); }, [controller, wallet.address, wallet.chainId]);
  const matching = wallet.address === state.beneficiary && wallet.chainId === BigInt(20261) && wallet.canProceed;
  let amountWei: bigint | null = null; try { amountWei = parseGrantAmount(amount); } catch { /* Show validation on submit, keep typed text. */ }
  if (wallet.address !== state.beneficiary) return <p role="status">Đang đọc ngân sách của ví đang chọn…</p>;
  const balance = state.lookup ? BigInt(state.lookup.balanceWei) : null;
  const blocked = !matching || state.busy || state.stale || state.storageBlocked || !state.lookup?.allowed || state.intent !== null
    || amountWei === null || balance === null || amountWei > balance;
  return <>
    <div className="wallet-summary-grid">
      <div className="metric-block"><span className="metric-label">Ngân sách FOOD</span>
        <strong className="tabular-value" data-testid="grant-balance">{balance === null ? "Chưa xác minh" : formatWalletBalance(balance)}</strong>
        <span className="metric-note">{state.lookup ? `${state.stale ? "Số dư đã xác minh gần nhất · cần đọc lại · " : "Đã đọc tại "}block #${state.lookup.block.number}` : "Đọc từ vault; khác số CAMPUS trong ví cá nhân"}</span>
      </div>
      <div className="metric-block"><span className="metric-label">Danh mục được cấp</span><strong>FOOD · Căn-tin</strong>
        <span className="metric-note">{state.lookup ? state.lookup.allowed ? "Căn-tin đang được phép nhận FOOD" : "Căn-tin đã bị tắt quyền nhận FOOD" : "Quyền merchant chưa xác minh"}</span>
      </div>
    </div>
    <div className="transaction-context">
      <span>Người chi · ví sinh viên</span><code className="mono-value">{state.beneficiary ?? "Chưa kết nối"}</code>
      <span>Merchant nhận · Căn-tin</span><code className="mono-value">{config.merchant}</code>
      <span>Vault · IntraCampus L1 · chain 20261</span><code className="mono-value">{config.vault}</code>
    </div>
    <form onSubmit={(event) => {
      event.preventDefault(); setInputError(null);
      try { void controller.spend(parseGrantAmount(amount)); } catch { setInputError(grantMessage("INVALID_AMOUNT")); }
    }}>
      <label className="field-label" htmlFor="grant-amount">Số CAMPUS chi từ voucher</label>
      <input id="grant-amount" className="mono-textarea" type="text" inputMode="decimal" autoComplete="off" value={amount}
        disabled={state.busy || state.intent !== null} onChange={(event) => { setAmount(event.target.value); setInputError(null); }} aria-describedby="grant-amount-help" />
      <p id="grant-amount-help" className="muted-line">{amountWei === null ? "Dùng số dương, dấu chấm cho phần lẻ, tối đa 18 chữ số thập phân."
        : <>Dự kiến trừ {formatWalletBalance(amountWei)} từ voucher. {balance !== null && amountWei > balance ? "Vượt số dư FOOD hiện tại." : ""}</>}</p>
      <p className="muted-line">Ví của bạn ký khoản chi. Giao dịch không gửi thêm CAMPUS vào vault; phí gas được trả riêng từ ví.</p>
      <div className="inline-actions">
        <button type="submit" className="primary-cta-btn" disabled={blocked}>Chi FOOD bằng Core</button>
        <button type="button" className="secondary-btn" disabled={!state.beneficiary || state.busy} onClick={() => void controller.refresh()}>Đọc lại / Tra receipt</button>
      </div>
    </form>
    {inputError ? <p role="alert">{inputError}</p> : null}
    {state.phase === "checking" || state.phase === "signing" || state.phase === "pending" ? <p role="status" aria-live="polite">
      {state.phase === "checking" ? "Đang kiểm tra lại số dư, mạng và mô phỏng khoản chi…" : state.phase === "signing" ? "Đang chờ bạn xác nhận trong Core…" : "Đã có hash, đang chờ receipt và event GrantSpent được xác minh…"}
    </p> : null}
    {state.message ? <p role={state.errorCode ? "alert" : "status"} className={state.errorCode ? "wallet-warning" : "wallet-status"}>{state.message}</p> : null}
    {!matching ? <p>Giữ đúng ví được cấp và chain 20261 để chi. Khi đổi tài khoản, số dư cũ được xóa khỏi màn hình.</p> : null}
    {state.intent?.hash ? <div className="tx-proof-box"><strong>Hash khoản chi · {state.phase === "confirmed" ? "Đã xác minh" : "Chưa xác nhận thành công"}</strong>
      <code className="tx-hash-code">{state.intent.hash}</code></div> : null}
    {state.phase === "prepared" ? <div>
      <p>Lượt trước dừng trước bước yêu cầu ví ký. Khôi phục lượt chưa gửi sẽ đọc lại số dư, không gửi giao dịch.</p>
      <button type="button" className="secondary-btn" disabled={!matching || state.busy || state.storageBlocked}
        onClick={() => void controller.reconcilePrepared()}>Khôi phục lượt chưa gửi</button>
    </div> : null}
    {state.phase === "unknown" || (state.intent?.recoveredHash && ["RECOVERY_HASH_REVERTED", "RECEIPT_MISMATCH", "INVALID_GRANT_RESPONSE"].includes(state.errorCode ?? "")) ? <form onSubmit={(event) => { event.preventDefault(); void controller.recoverHash(recoveryHash.trim()); }}>
      <label htmlFor="grant-recovery-hash" className="field-label">Hash từ lịch sử giao dịch Core</label>
      <input id="grant-recovery-hash" className="mono-textarea" value={recoveryHash} onChange={(event) => setRecoveryHash(event.target.value)} autoComplete="off" />
      <p className="muted-line">Khoản chi trước chưa rõ kết quả. Tra giao dịch đã ký; không xóa dữ liệu trình duyệt hoặc gửi lại.</p>
      <button type="submit" className="secondary-btn" disabled={state.busy}>Đối chiếu hash đã gửi</button>
    </form> : null}
    {state.phase === "confirmed" || state.phase === "reverted" ? <button type="button" className="secondary-btn" disabled={state.busy} onClick={() => void controller.newSpend()}>Xem lại số dư để tạo khoản chi mới</button> : null}
    <details className="module-accordion"><summary>Giới hạn voucher</summary><div className="accordion-content">
      <p>Ngân sách này chỉ chi FOOD tại căn-tin đã xác minh. Không rút về ví cá nhân hoặc đổi sang PARKING. Contract kiểm tra quyền merchant ở mỗi lần chi.</p>
      <p>Chỉ receipt thành công và event khớp mới xác nhận khoản chi. Lỗi RPC giữ số dư lần đọc trước với nhãn cần xác minh lại.</p>
    </div></details>
  </>;
}

export default function GrantPanel() {
  const { controller: wallet } = useCampusWallet();
  const [session, setSession] = useState<{ controller: GrantController; config: GrantConfig } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let controller: GrantController | undefined;
    try {
      const config = grantConfig(), rpcUrl = browserWalletConfig().rpcUrl;
      if (!rpcUrl) throw new Error("RPC_UNAVAILABLE");
      controller = new GrantController({ config, rpc: createWalletRpc(rpcUrl), wallet, storage: window.localStorage });
      setSession({ controller, config });
    } catch (cause) { setError(grantMessage(cause instanceof Error ? cause.message : "DEPLOYMENT_NOT_CONFIGURED")); }
    return () => controller?.dispose();
  }, [wallet]);
  return <section className="surface-panel" aria-labelledby="grant-title">
    <h2 id="grant-title">Voucher học bổng</h2>
    <p>Chi ngân sách FOOD tại căn-tin bằng ví được cấp.</p>
    {error ? <p role="status">{error}</p> : session ? <GrantView controller={session.controller} config={session.config} /> : <p role="status">Đang kiểm tra cấu hình học bổng…</p>}
  </section>;
}
