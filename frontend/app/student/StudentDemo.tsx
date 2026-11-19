"use client";

import { campusNetwork } from "@intracampus/network";
import { useEffect, useState, type FormEvent } from "react";
import { parseGrantAmount } from "../../lib/grants";
import HashChip from "../components/HashChip";
import Icon from "../components/Icon";
import TransactionStepper, { type StepState } from "../components/TransactionStepper";
import { CopyButton, DemoControls } from "../demo-controls";
import {
  DEMO_CANTEEN_MERCHANT_WALLET,
  calculateInvoiceQuote,
  demoErrorScenarios,
  demoWalletProfiles,
  formatCampusWei,
  getDemoReceiptFixture,
  matchesSharedDemoPayload,
  sharedParkingInvoiceEnvelope,
  sharedQrPayloadString,
  shortenHex,
  type DemoErrorKind,
  type DemoUiState,
  type DemoWalletKind,
} from "../demo-fixtures";

const INITIAL_FOOD_GRANT_WEI = BigInt("150000000000000000000"); // 150 CAMPUS
const DEMO_GRANT_VAULT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const DEMO_GRANT_TX_HASH =
  "0x7a4c1d9e0f2b3a4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3cc";

type DemoGrantPhase = "idle" | "signing" | "confirming" | "confirmed";

function paymentDemoStep(uiState: DemoUiState): StepState {
  if (uiState === "loading") return "checking";
  if (uiState === "awaiting-signature") return "signing";
  if (uiState === "pending") return "confirming";
  if (uiState === "receipt") return "done";
  if (uiState === "error") return "error";
  return "idle";
}

function grantDemoStep(phase: DemoGrantPhase): StepState {
  if (phase === "signing") return "signing";
  if (phase === "confirming") return "confirming";
  if (phase === "confirmed") return "done";
  return "idle";
}

const walletStatusLabel: Record<DemoUiState, string> = {
  waiting: "Đã đọc dữ liệu mẫu · Sẵn sàng thanh toán QR",
  loading: "Đang kiểm tra hóa đơn và ưu đãi mẫu…",
  "awaiting-signature": "Đang chờ bạn xác nhận ký trong ví (mô phỏng)",
  pending: "Đang chờ xác nhận giao dịch trên L1 (mô phỏng)",
  error: "Đang mô phỏng tình huống lỗi",
  receipt: "Đã có biên lai mẫu · Chưa xác minh on-chain",
};

export default function StudentDemo({
  onBackToLive,
}: {
  onBackToLive?: () => void;
} = {}) {
  const [uiState, setUiState] = useState<DemoUiState>("waiting");
  const [walletKind, setWalletKind] = useState<DemoWalletKind>("sbt");
  const [errorKind, setErrorKind] = useState<DemoErrorKind>("expired");
  const [pastedQr, setPastedQr] = useState(sharedQrPayloadString);
  const [previewVerified, setPreviewVerified] = useState(true);
  const [addressCopied, setAddressCopied] = useState(false);

  const [grantBalanceWei, setGrantBalanceWei] = useState<bigint>(INITIAL_FOOD_GRANT_WEI);
  const [grantAmount, setGrantAmount] = useState("25");
  const [grantPhase, setGrantPhase] = useState<DemoGrantPhase>("idle");
  const [grantError, setGrantError] = useState<string | null>(null);
  const [pendingGrantWei, setPendingGrantWei] = useState<bigint | null>(null);

  const payloadMatches = matchesSharedDemoPayload(pastedQr);
  const wallet = demoWalletProfiles[walletKind];
  const invoice = sharedParkingInvoiceEnvelope;
  const quote = calculateInvoiceQuote(
    invoice.invoice.amount,
    wallet.sbt.discountBps,
  );
  const receipt = getDemoReceiptFixture(walletKind);
  const activeError = demoErrorScenarios[errorKind];
  const isWrongChain = uiState === "error" && errorKind === "wrong-chain";

  useEffect(() => {
    if (!addressCopied) return;
    const timer = window.setTimeout(() => setAddressCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [addressCopied]);

  let parsedGrantWei: bigint | null = null;
  try {
    parsedGrantWei = parseGrantAmount(grantAmount);
  } catch {
    /* Hiển thị lỗi khi người dùng bấm chi, giữ nguyên text đang gõ. */
  }

  function resetPreview() {
    setPastedQr(sharedQrPayloadString);
    setPreviewVerified(true);
    setUiState("waiting");
  }

  function startGrantSpend(event: FormEvent) {
    event.preventDefault();
    setGrantError(null);
    let wei: bigint;
    try {
      wei = parseGrantAmount(grantAmount);
    } catch {
      setGrantError("Số CAMPUS không hợp lệ. Dùng số dương, dấu chấm cho phần lẻ.");
      return;
    }
    if (wei > grantBalanceWei) {
      setGrantError("Số tiền vượt quá ngân sách FOOD mẫu hiện có.");
      return;
    }
    setPendingGrantWei(wei);
    setGrantPhase("signing");
  }

  function confirmDemoGrantReceipt() {
    if (pendingGrantWei === null) return;
    setGrantBalanceWei((prev) => (prev >= pendingGrantWei ? prev - pendingGrantWei : BigInt(0)));
    setGrantPhase("confirmed");
  }

  function resetDemoGrant() {
    setGrantBalanceWei(INITIAL_FOOD_GRANT_WEI);
    setGrantAmount("25");
    setGrantPhase("idle");
    setGrantError(null);
    setPendingGrantWei(null);
  }

  return (
    <>
      <DemoControls
        state={uiState}
        wallet={walletKind}
        error={errorKind}
        onState={setUiState}
        onWallet={setWalletKind}
        onError={setErrorKind}
        onBackToLive={onBackToLive}
        backToLiveLabel="Ví thật →"
        summary="Mô phỏng đầy đủ Ví sinh viên, QR POS và Voucher FOOD · chưa kết nối ví thật"
      />

      <div className="student-shell live-wallet-view">
        {/* Cột trái sticky: Thẻ sinh viên SBT & Số dư ví mẫu */}
        <section
          className="surface-panel student-identity-panel"
          aria-labelledby="demo-wallet-title"
          aria-busy={uiState === "loading"}
        >
          <div className="panel-top-row">
            <div>
              <span className="panel-eyebrow">CAMPUS WALLET · MINH HỌA</span>
              <h2 id="demo-wallet-title" className="screen-title">
                Ví sinh viên
              </h2>
              <p className="screen-subtitle">Số dư và quyền ưu đãi của bạn</p>
            </div>
            <span
              className={`network-pill ${isWrongChain ? "pill-danger" : "pill-ok"}`}
            >
              <span className="status-dot" aria-hidden="true" />
              {isWrongChain ? "Mẫu lỗi · Sai mạng" : `${campusNetwork.name} (Mẫu)`}
            </span>
          </div>

          <div className="campus-live-pass" aria-hidden="true">
            <div className="live-pass-top">
              <span className="live-pass-brand">
                <Icon name="graduation" />
                IntraCampus Pass
              </span>
              <span className="live-pass-chain">
                {isWrongChain ? "CHỜ MẠNG 20261" : "L1 · 20261 (MẪU)"}
              </span>
            </div>
            <div className="live-pass-body">
              <div className="pass-chip">
                <i />
                <i />
                <i />
              </div>
              <div className="live-pass-identity">
                <span className="live-pass-kicker">
                  {wallet.sbt.hasValidCard
                    ? "THẺ SINH VIÊN SBT · ƯU ĐÃI -10%"
                    : "TÀI KHOẢN TIÊU CHUẨN · GIÁ GỐC"}
                </span>
                <strong>{shortenHex(wallet.address, 6, 4)}</strong>
              </div>
              <Icon name="leaf" className="live-pass-leaf" />
            </div>
            <div className="live-pass-bottom">
              <span>
                {wallet.sbt.hasValidCard ? "PASS #0001 · MẪU" : "CHƯA CẤP MÃ THẺ"}
              </span>
              <span>
                {wallet.sbt.hasValidCard
                  ? `HẠN ${wallet.sbt.expiresAtLabel}`
                  : "INTRACAMPUS L1"}
              </span>
            </div>
          </div>

          <p className="wallet-status" role="status">
            {isWrongChain
              ? "Ví mẫu đang ở sai mạng"
              : walletStatusLabel[uiState]}
          </p>

          {isWrongChain ? (
            <p className="wallet-warning">
              Ví mẫu đang ở sai mạng. Hãy chuyển sang IntraCampus L1 · Chain{" "}
              {campusNetwork.chainId} trước khi tiếp tục.
            </p>
          ) : null}

          <div className="wallet-summary-grid">
            <div className="metric-block metric-block-wide">
              <span className="metric-label">Tài khoản ví mẫu</span>
              <div className="wallet-address-row">
                <code className="wallet-address" translate="no">
                  {wallet.address}
                </code>
                <button
                  type="button"
                  className={`hash-chip-btn hash-copy-icon-btn ${addressCopied ? "is-copied" : ""}`}
                  aria-label={`Sao chép địa chỉ ví mẫu: ${wallet.address}`}
                  title={addressCopied ? "Đã chép" : "Sao chép địa chỉ ví mẫu"}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(wallet.address)
                      .then(() => setAddressCopied(true))
                      .catch(() => {});
                  }}
                >
                  <Icon name={addressCopied ? "check" : "copy"} />
                  {addressCopied ? <span>Đã chép</span> : null}
                </button>
              </div>
              <span className="metric-note">
                {wallet.studentName} · {wallet.studentIdLabel}
              </span>
            </div>

            <div className="metric-block">
              <span className="metric-label">Số dư CAMPUS</span>
              <strong className="tabular-value wallet-balance">
                {formatCampusWei(wallet.balanceWei)}
              </strong>
              <span className="metric-note">Số dư mẫu · Chưa đọc từ ví</span>
            </div>

            <div className="metric-block">
              <span className="metric-label">Mức ưu đãi hiện tại</span>
              <strong>
                {wallet.sbt.hasValidCard
                  ? "Giảm 10% tự động"
                  : "Giá niêm yết (0%)"}
              </strong>
              <span className="metric-note">
                {wallet.sbt.hasValidCard
                  ? "Áp dụng cho bãi xe & nhà ăn"
                  : "Cần thẻ SBT còn hạn để giảm 10%"}
              </span>
            </div>
          </div>

          <div
            className={`sbt-banner ${wallet.sbt.hasValidCard ? "sbt-active" : "sbt-muted"}`}
          >
            <div className="sbt-banner-head">
              <strong>{wallet.sbt.badgeLabel}</strong>
              <span className="sbt-badge">Tier {wallet.sbt.tier}</span>
            </div>
            <p>{wallet.sbt.friendlyStatus}</p>
            <span className="sbt-meta">
              {wallet.sbt.hasValidCard
                ? `Thẻ #1 (Mẫu) · Hạn sử dụng: ${wallet.sbt.expiresAtLabel}`
                : `Trạng thái: ${wallet.sbt.expiresAtLabel}`}
            </span>
            {!wallet.sbt.hasValidCard ? (
              <div className="sbt-tier0-guidance">
                <button
                  type="button"
                  className="link-action-btn"
                  onClick={() => setWalletKind("sbt")}
                >
                  Đổi sang ví mẫu có thẻ SBT (-10%) →
                </button>
              </div>
            ) : null}
          </div>

          <div className="inline-actions wallet-actions">
            <button
              type="button"
              className="secondary-btn"
              onClick={() =>
                setWalletKind(walletKind === "sbt" ? "standard" : "sbt")
              }
            >
              {walletKind === "sbt"
                ? "Thử ví không có thẻ (0%)"
                : "Thử ví có thẻ SBT (-10%)"}
            </button>
            {onBackToLive ? (
              <button
                type="button"
                className="secondary-btn"
                onClick={onBackToLive}
              >
                Chuyển sang Ví thật
              </button>
            ) : null}
          </div>
        </section>

        {/* Cột phải 01 / 02: Quét & thanh toán QR */}
        <section
          className="surface-panel wallet-payment-gate"
          aria-labelledby="payment-gate-title"
          aria-busy={uiState === "loading"}
        >
          <div className="panel-heading-with-icon">
            <span className="panel-icon">
              <Icon name="qr" />
            </span>
            <div>
              <span className="panel-eyebrow">QUÉT & THANH TOÁN</span>
              <h2 id="payment-gate-title">Thanh toán bằng QR</h2>
            </div>
            <span className="step-label">01 / 02</span>
          </div>
          <p>
            Dán hoặc dùng phiếu mẫu từ điểm thu trên chain{" "}
            {campusNetwork.chainId} để xem trước số CAMPUS cần trả và thử bước ký
            ví Core.
          </p>

          <div className="invoice-student-preview">
            <h3>Quét hoặc dán hóa đơn POS</h3>
            <p>
              Đối chiếu phiếu mẫu và mức giảm SBT, sau đó mô phỏng xác nhận ký
              tới payment registry.
            </p>

            <div className="qr-source-header">
              <label htmlFor="student-qr-paste">Payload QR mẫu</label>
              <div className="qr-paste-actions">
                <button
                  type="button"
                  className="text-action-btn pos-bridge-btn"
                  onClick={resetPreview}
                >
                  Dùng phiếu mẫu POS
                </button>
                {pastedQr ? (
                  <button
                    type="button"
                    className="text-action-btn"
                    onClick={() => {
                      setPastedQr("");
                      setPreviewVerified(false);
                      setUiState("waiting");
                    }}
                  >
                    Xóa
                  </button>
                ) : null}
              </div>
            </div>

            <textarea
              id="student-qr-paste"
              className="invoice-payload"
              rows={3}
              value={pastedQr}
              placeholder="Dán nội dung phiếu mẫu từ trang Điểm thu (/pos) vào đây…"
              aria-describedby="payload-feedback"
              onChange={(e) => {
                setPastedQr(e.target.value);
                setPreviewVerified(matchesSharedDemoPayload(e.target.value));
              }}
            />
            <p id="payload-feedback" className="metric-note" role="status">
              {payloadMatches
                ? "Nội dung khớp phiếu mẫu dùng chung với POS. Chưa xác minh chữ ký thật."
                : "Nội dung chưa khớp phiếu mẫu. Nút thanh toán đang bị khóa."}
            </p>

            <div className="inline-actions invoice-preview-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={resetPreview}
              >
                Lấy lại phiếu mẫu
              </button>
              <button
                type="button"
                className="primary-cta-btn"
                disabled={
                  !payloadMatches ||
                  uiState === "loading" ||
                  uiState === "awaiting-signature" ||
                  uiState === "pending"
                }
                onClick={() => {
                  setPreviewVerified(true);
                  setUiState("waiting");
                }}
              >
                {uiState === "loading"
                  ? "Đang kiểm tra phiếu…"
                  : uiState === "awaiting-signature"
                    ? "Đang chờ ký trong ví…"
                    : uiState === "pending"
                      ? "Đang chờ xác nhận L1…"
                      : uiState === "error" || uiState === "receipt"
                        ? "Kiểm tra lại hóa đơn mẫu"
                        : "Kiểm tra hóa đơn mẫu"}
              </button>
            </div>

            {!payloadMatches ? (
              <p className="invoice-feedback error-panel" role="alert">
                Nội dung vừa nhập không khớp phiếu mẫu chuẩn. Bấm “Dùng phiếu
                mẫu POS” hoặc “Lấy lại phiếu mẫu” để khôi phục.
              </p>
            ) : null}

            {uiState === "loading" ? (
              <div aria-live="polite" aria-busy="true">
                <TransactionStepper state="checking" />
                <div className="status-banner banner-loading">
                  <span className="spinner" aria-hidden="true" />
                  <div>
                    <strong>
                      Đang kiểm tra phiếu gửi xe và thẻ sinh viên…
                    </strong>
                    <p>
                      Hệ thống đang mô phỏng tra cứu chữ ký POS và quyền ưu đãi
                      SBT trên chain {campusNetwork.chainId}.
                    </p>
                  </div>
                </div>
                <div className="skeleton-list" aria-hidden="true">
                  <div className="skeleton-row" />
                  <div className="skeleton-row" />
                  <div className="skeleton-row short" />
                </div>
              </div>
            ) : null}

            {uiState === "error" ? (
              <div className="invoice-feedback error-panel" role="alert">
                <TransactionStepper state="error" />
                <div className="error-header">
                  <span className="error-code-badge">
                    Tình huống mẫu · {activeError.code}
                  </span>
                  <strong>{activeError.studentTitle}</strong>
                </div>
                <p className="error-body">{activeError.studentMessage}</p>
                <div className="next-step-box">
                  <strong>Bạn chỉ cần làm bước này:</strong>
                  <p>{activeError.nextStepStudent}</p>
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="primary-cta-btn"
                    onClick={resetPreview}
                  >
                    {activeError.actionLabelStudent}
                  </button>
                </div>
              </div>
            ) : null}

            {(uiState === "waiting" && previewVerified) ||
            uiState === "awaiting-signature" ||
            uiState === "pending" ? (
              <section
                className="invoice-verified-preview"
                aria-live="polite"
                aria-label="Hóa đơn mẫu đã xem trước"
              >
                <span className="verified-badge tabular-nums">
                  PHIẾU MẪU · Chain {campusNetwork.chainId} · Hạn mẫu 05:00
                </span>
                <h4>{invoice.meta.serviceName}</h4>
                <p>
                  {invoice.meta.merchantName} · người nhận{" "}
                  <HashChip
                    value={invoice.invoice.merchant}
                    copyLabel="Sao chép địa chỉ merchant mẫu"
                  />
                </p>
                <h5>
                  {wallet.sbt.hasValidCard
                    ? "Đủ điều kiện giảm giá SBT (-10%)"
                    : "Không áp dụng giảm giá SBT"}
                </h5>

                <dl className="price-breakdown tabular-nums">
                  <div className="price-row">
                    <dt>Giá vé niêm yết</dt>
                    <dd className="tabular-nums">
                      {formatCampusWei(quote.originalAmountWei)}
                    </dd>
                  </div>
                  <div className="price-row discount-row">
                    <dt>
                      Ưu đãi thẻ sinh viên (
                      {wallet.sbt.hasValidCard ? "Giảm 10%" : "0%"})
                    </dt>
                    <dd className="tabular-nums">
                      {quote.discountBps > 0
                        ? `-${formatCampusWei(quote.discountAmountWei)}`
                        : "0 CAMPUS"}
                    </dd>
                  </div>
                  <div className="price-row total-row">
                    <dt>Số CAMPUS cần trả</dt>
                    <dd className="total-amount tabular-nums">
                      {formatCampusWei(quote.paidAmountWei)}
                    </dd>
                  </div>
                  <div className="price-row gas-row">
                    <dt>Phí gas mẫu (tách riêng)</dt>
                    <dd className="tabular-nums">
                      ~{formatCampusWei(quote.estimatedGasWei)}
                    </dd>
                  </div>
                </dl>

                <div className="invoice-payment-panel">
                  <h4>Thanh toán bằng ví sinh viên (Mô phỏng)</h4>
                  <p>
                    {uiState === "awaiting-signature"
                      ? "Kiểm tra số tiền và đích nhận. Trong bản thật, ví Core sẽ bật cửa sổ xác nhận ở bước này."
                      : uiState === "pending"
                        ? "Đã gửi mô phỏng. Chưa có receipt hợp lệ thì chưa báo thanh toán thành công."
                        : "Hạn, paid flag, verifier/signer, giá và mô phỏng được đối chiếu trước khi mở Core xác nhận."}
                  </p>
                  <TransactionStepper state={paymentDemoStep(uiState)} />
                  <p>
                    Ví trả:{" "}
                    <HashChip
                      value={wallet.address}
                      copyLabel="Sao chép địa chỉ ví trả mẫu"
                    />
                  </p>
                  <p>
                    Người nhận CAMPUS:{" "}
                    <HashChip
                      value={invoice.invoice.merchant}
                      copyLabel="Sao chép địa chỉ người nhận mẫu"
                    />
                  </p>
                  <p>
                    <strong>
                      Số tiền cần xác nhận:{" "}
                      {formatCampusWei(quote.paidAmountWei)}
                    </strong>
                  </p>

                  {uiState === "pending" ? (
                    <>
                      <p className="wallet-status" role="status">
                        Đang chờ receipt và sự kiện khớp hóa đơn (mô phỏng)…
                      </p>
                      <p>Tx hash mẫu</p>
                      <code className="tx-hash-code">{receipt.txHash}</code>
                      <CopyButton
                        key={walletKind}
                        label="Sao chép hash thanh toán mẫu"
                        value={receipt.txHash}
                      />
                    </>
                  ) : null}

                  <div className="inline-actions invoice-preview-actions">
                    {uiState === "waiting" ? (
                      <button
                        type="button"
                        className="primary-cta-btn"
                        disabled={!payloadMatches}
                        onClick={() => setUiState("awaiting-signature")}
                      >
                        Thanh toán bằng Core (Mô phỏng)
                      </button>
                    ) : null}

                    {uiState === "awaiting-signature" ? (
                      <>
                        <button
                          type="button"
                          className="primary-cta-btn"
                          onClick={() => setUiState("pending")}
                        >
                          Mô phỏng đồng ý ký
                        </button>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => {
                            setErrorKind("wallet-rejected");
                            setUiState("error");
                          }}
                        >
                          Mô phỏng từ chối ký
                        </button>
                      </>
                    ) : null}

                    {uiState === "pending" ? (
                      <>
                        <button
                          type="button"
                          className="primary-cta-btn"
                          onClick={() => setUiState("receipt")}
                        >
                          Xem biên lai mẫu
                        </button>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => {
                            setErrorKind("rpc-unreachable");
                            setUiState("error");
                          }}
                        >
                          Thử lỗi xác minh
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}

            {uiState === "receipt" ? (
              <section className="invoice-payment-panel" aria-live="polite">
                <TransactionStepper state="done" />
                <h4>Thanh toán đã xác minh (Mẫu)</h4>
                <p role="status">
                  Biên lai giả lập cho cùng hóa đơn với POS. Chưa có xác nhận
                  on-chain.
                </p>
                <div className="invoice-verified-preview">
                  <span className="verified-badge">
                    BIÊN LAI MẪU · CHƯA XÁC MINH ON-CHAIN
                  </span>
                  <dl className="price-breakdown tabular-nums">
                    <div className="price-row">
                      <dt>Mã hóa đơn</dt>
                      <dd>{receipt.invoiceCode}</dd>
                    </div>
                    <div className="price-row">
                      <dt>Giá gốc</dt>
                      <dd>{formatCampusWei(receipt.originalAmountWei)}</dd>
                    </div>
                    <div className="price-row discount-row">
                      <dt>Ưu đãi (tier {receipt.tier})</dt>
                      <dd>
                        {receipt.tier === 1
                          ? `-${formatCampusWei(receipt.discountAmountWei)}`
                          : "0 CAMPUS"}
                      </dd>
                    </div>
                    <div className="price-row total-row">
                      <dt>Đã trả (mẫu)</dt>
                      <dd className="total-amount">
                        {formatCampusWei(receipt.paidAmountWei)}
                      </dd>
                    </div>
                    <div className="price-row gas-row">
                      <dt>Gas (riêng)</dt>
                      <dd>{formatCampusWei(receipt.gasFeeWei)}</dd>
                    </div>
                    <div className="price-row">
                      <dt>Block / log</dt>
                      <dd>#{receipt.blockNumber} / 0 (Mẫu)</dd>
                    </div>
                  </dl>
                  <details>
                    <summary>Chi tiết giao dịch mẫu</summary>
                    <p>Người trả</p>
                    <code className="tx-hash-code">{receipt.payer}</code>
                    <p>Người nhận</p>
                    <code className="tx-hash-code">{receipt.merchant}</code>
                    <p>Hợp đồng · chain {receipt.chainId}</p>
                    <code className="tx-hash-code">
                      {receipt.contractAddress}
                    </code>
                    <p>Tx hash mẫu</p>
                    <code className="tx-hash-code">{receipt.txHash}</code>
                    <CopyButton
                      key={walletKind}
                      label="Sao chép tx hash mẫu"
                      value={receipt.txHash}
                    />
                  </details>
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={resetPreview}
                  >
                    Quay lại hóa đơn mẫu
                  </button>
                </div>
              </section>
            ) : null}
          </div>

          <details className="module-accordion">
            <summary>
              <span>Thông tin fixture</span>
              <span className="muted-tag">Chain {campusNetwork.chainId}</span>
            </summary>
            <div className="accordion-content">
              <dl className="meta-grid">
                <div>
                  <dt>Địa chỉ ví đang chọn</dt>
                  <dd className="mono-value">
                    {shortenHex(wallet.address, 8, 6)}
                  </dd>
                </div>
                <div>
                  <dt>Verifier mẫu · CampusPaymentRegistry</dt>
                  <dd className="mono-value">
                    {shortenHex(invoice.domain.verifyingContract, 8, 6)}
                  </dd>
                </div>
                <div>
                  <dt>Mã băm invoiceId</dt>
                  <dd className="mono-value">
                    {shortenHex(invoice.invoice.invoiceId, 10, 6)}
                  </dd>
                </div>
                <div>
                  <dt>Chữ ký EIP-712 POS</dt>
                  <dd className="mono-value">
                    {shortenHex(invoice.signature, 10, 6)}
                  </dd>
                </div>
              </dl>
            </div>
          </details>
        </section>

        {/* Cột phải 02 / 02: Voucher học bổng FOOD */}
        <section
          className="surface-panel grant-panel"
          aria-labelledby="grant-title"
        >
          <div className="panel-heading-with-icon">
            <span className="panel-icon icon-gold">
              <Icon name="sparkle" />
            </span>
            <div>
              <span className="panel-eyebrow">MỘT BỮA TRƯA, THÊM NĂNG LƯỢNG</span>
              <h2 id="grant-title">Voucher học bổng</h2>
            </div>
            <span className="step-label">02 / 02</span>
          </div>
          <p>
            Chi ngân sách FOOD tại căn-tin bằng ví được cấp (mô phỏng trên
            trình duyệt).
          </p>

          <div className="wallet-summary-grid">
            <div className="metric-block">
              <span className="metric-label">Ngân sách FOOD</span>
              <strong className="tabular-value" data-testid="demo-grant-balance">
                {formatCampusWei(grantBalanceWei.toString())}
              </strong>
              <span className="metric-note">
                Số dư mẫu trong vault · khác CAMPUS trong ví cá nhân
              </span>
            </div>
            <div className="metric-block">
              <span className="metric-label">Danh mục được cấp</span>
              <strong>FOOD · Căn-tin</strong>
              <span className="metric-note">
                Căn-tin đang được phép nhận FOOD (mô phỏng)
              </span>
            </div>
          </div>

          <div className="transaction-context">
            <span>Người chi · ví sinh viên</span>
            <HashChip
              value={wallet.address}
              copyLabel="Sao chép ví sinh viên mẫu"
            />
            <span>Merchant nhận · Căn-tin</span>
            <HashChip
              value={DEMO_CANTEEN_MERCHANT_WALLET}
              copyLabel="Sao chép địa chỉ căn-tin mẫu"
            />
            <span>Vault · IntraCampus L1 · chain {campusNetwork.chainId}</span>
            <HashChip
              value={DEMO_GRANT_VAULT}
              copyLabel="Sao chép địa chỉ vault mẫu"
            />
          </div>

          <TransactionStepper state={grantDemoStep(grantPhase)} />

          <form onSubmit={startGrantSpend}>
            <label className="field-label" htmlFor="demo-grant-amount">
              Số CAMPUS chi từ voucher
            </label>
            <input
              id="demo-grant-amount"
              className="mono-textarea amount-input tabular-nums"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={grantAmount}
              disabled={grantPhase !== "idle"}
              onChange={(e) => {
                setGrantAmount(e.target.value);
                setGrantError(null);
              }}
              aria-describedby="demo-grant-amount-help"
            />
            <p
              id="demo-grant-amount-help"
              className="muted-line tabular-nums"
            >
              {parsedGrantWei === null
                ? "Dùng số dương, dấu chấm cho phần lẻ, tối đa 18 chữ số thập phân."
                : `Dự kiến trừ ${formatCampusWei(parsedGrantWei.toString())} từ voucher. ${
                    parsedGrantWei > grantBalanceWei
                      ? "Vượt số dư FOOD mẫu hiện tại."
                      : ""
                  }`}
            </p>
            <p className="muted-line">
              Ví của bạn ký khoản chi. Giao dịch không gửi thêm CAMPUS vào
              vault; phí gas được trả riêng từ ví.
            </p>

            {grantPhase === "idle" ? (
              <div className="inline-actions">
                <button
                  type="submit"
                  className="primary-cta-btn"
                  disabled={
                    parsedGrantWei === null || parsedGrantWei > grantBalanceWei
                  }
                >
                  Chi FOOD mẫu bằng Core
                </button>
                {grantBalanceWei !== INITIAL_FOOD_GRANT_WEI ? (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={resetDemoGrant}
                  >
                    Đặt lại 150 CAMPUS
                  </button>
                ) : null}
              </div>
            ) : null}
          </form>

          {grantError ? (
            <p className="wallet-warning" role="alert">
              {grantError}
            </p>
          ) : null}

          {grantPhase === "signing" ? (
            <div className="inline-actions">
              <button
                type="button"
                className="primary-cta-btn"
                onClick={() => setGrantPhase("confirming")}
              >
                Mô phỏng đồng ý ký chi FOOD
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  setGrantPhase("idle");
                  setPendingGrantWei(null);
                }}
              >
                Hủy ký
              </button>
            </div>
          ) : null}

          {grantPhase === "confirming" ? (
            <div className="inline-actions">
              <button
                type="button"
                className="primary-cta-btn"
                onClick={confirmDemoGrantReceipt}
              >
                Xác nhận biên nhận GrantSpent mẫu
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  setGrantPhase("idle");
                  setPendingGrantWei(null);
                }}
              >
                Quay lại
              </button>
            </div>
          ) : null}

          {grantPhase === "confirmed" ? (
            <>
              <div className="tx-proof-box">
                <strong>
                  Hash khoản chi mẫu · Chưa xác minh on-chain (
                  {pendingGrantWei
                    ? `-${formatCampusWei(pendingGrantWei.toString())}`
                    : "Đã trừ"}
                  )
                </strong>
                <div>
                  <HashChip
                    value={DEMO_GRANT_TX_HASH}
                    start={10}
                    end={8}
                    copyLabel="Sao chép mã giao dịch FOOD mẫu"
                  />
                </div>
              </div>
              <div className="inline-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => {
                    setGrantPhase("idle");
                    setPendingGrantWei(null);
                  }}
                >
                  Tạo khoản chi mẫu mới
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={resetDemoGrant}
                >
                  Đặt lại 150 CAMPUS
                </button>
              </div>
            </>
          ) : null}

          <details className="module-accordion">
            <summary>Giới hạn voucher</summary>
            <div className="accordion-content">
              <p>
                Ngân sách này chỉ chi FOOD tại căn-tin đã xác minh. Không rút về
                ví cá nhân hoặc đổi sang PARKING. Contract kiểm tra quyền
                merchant ở mỗi lần chi.
              </p>
              <p>
                Trong bản thật, chỉ receipt thành công và event GrantSpent khớp
                mới xác nhận khoản chi.
              </p>
            </div>
          </details>
        </section>

        <p className="wallet-live-note">
          Bản minh họa chỉ mô phỏng dữ liệu trên trình duyệt, không kết nối ví
          Core hoặc gửi giao dịch lên mạng.
        </p>
      </div>
    </>
  );
}
