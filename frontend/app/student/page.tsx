"use client";

import { campusNetwork } from "@intracampus/network";
import { useState } from "react";
import { CopyButton, DemoControls } from "../demo-controls";
import {
  calculateInvoiceQuote,
  type DemoErrorKind,
  demoErrorScenarios,
  type DemoUiState,
  type DemoWalletKind,
  demoWalletProfiles,
  formatCampusWei,
  getDemoReceiptFixture,
  sharedParkingInvoiceEnvelope,
  sharedQrPayloadString,
  matchesSharedDemoPayload,
  shortenHex,
} from "../demo-fixtures";

export default function StudentPage() {
  const [uiState, setUiState] = useState<DemoUiState>("waiting");
  const [walletKind, setWalletKind] = useState<DemoWalletKind>("sbt");
  const [errorKind, setErrorKind] = useState<DemoErrorKind>("expired");
  const [qrInputOpen, setQrInputOpen] = useState(false);
  const [pastedQr, setPastedQr] = useState(sharedQrPayloadString);
  const payloadMatches = matchesSharedDemoPayload(pastedQr);

  const wallet = demoWalletProfiles[walletKind];
  const invoice = sharedParkingInvoiceEnvelope;
  const quote = calculateInvoiceQuote(
    invoice.invoice.amount,
    wallet.sbt.discountBps,
  );
  const receipt = getDemoReceiptFixture(walletKind);
  const activeError = demoErrorScenarios[errorKind];

  function resetPreview() {
    setPastedQr(sharedQrPayloadString);
    setUiState("waiting");
  }

  return (
    <div className="student-shell">
      <DemoControls
        state={uiState}
        wallet={walletKind}
        error={errorKind}
        onState={setUiState}
        onWallet={setWalletKind}
        onError={setErrorKind}
      />

      {/* Thẻ sinh viên & Số dư ví trường học */}
      <header className="surface-panel student-identity-panel">
        <div className="panel-top-row">
          <div>
            <h1 className="screen-title">Ví sinh viên</h1>
            <p className="screen-subtitle">
              Thanh toán trong khuôn viên trường
            </p>
          </div>
          <span
            className={
              uiState === "error" && errorKind === "wrong-chain"
                ? "network-pill pill-danger"
                : "network-pill pill-ok"
            }
          >
            <span className="status-dot" aria-hidden="true" />
            {uiState === "error" && errorKind === "wrong-chain"
              ? "Mẫu lỗi · Sai mạng"
              : "Mạng mẫu · IntraCampus L1"}
          </span>
        </div>

        <div className="wallet-summary-grid">
          <div className="metric-block">
            <span className="metric-label">Sinh viên</span>
            <strong>{wallet.studentName}</strong>
            <span className="metric-note">{wallet.studentIdLabel}</span>
          </div>
          <div className="metric-block">
            <span className="metric-label">Số dư hiện có</span>
            <strong className="tabular-value">
              {formatCampusWei(wallet.balanceWei)}
            </strong>
            <span className="metric-note">Số dư mẫu · Chưa đọc từ ví</span>
          </div>
        </div>

        <div
          className={
            wallet.sbt.hasValidCard
              ? "sbt-banner sbt-active"
              : "sbt-banner sbt-muted"
          }
        >
          <div className="sbt-banner-head">
            <strong>{wallet.sbt.badgeLabel}</strong>
            <span className="sbt-badge">
              {wallet.sbt.hasValidCard ? "Tự động giảm 10%" : "Tính nguyên giá"}
            </span>
          </div>
          <p>{wallet.sbt.friendlyStatus}</p>
          <span className="sbt-meta">
            Hạn sử dụng thẻ: {wallet.sbt.expiresAtLabel}
          </span>
        </div>
      </header>

      {/* Ô dán fixture; chưa mở camera hoặc xác minh QR thật */}
      <section
        className="surface-panel qr-source-panel"
        aria-label="Thông tin phiếu thu từ nhà xe"
      >
        <div className="qr-source-header">
          <div>
            <h2>Hóa đơn mẫu · {invoice.meta.merchantName}</h2>
            <p className="muted-line">
              Mã số phiếu:{" "}
              <code className="inline-code">{invoice.meta.invoiceCode}</code>
            </p>
          </div>
          <button
            type="button"
            className="secondary-btn"
            aria-expanded={qrInputOpen}
            onClick={() => setQrInputOpen((prev) => !prev)}
          >
            {qrInputOpen ? "Đóng ô nhập" : "Dán phiếu mẫu"}
          </button>
        </div>

        {qrInputOpen ? (
          <div className="qr-paste-box">
            <label htmlFor="student-qr-paste" className="field-label">
              Dán nội dung phiếu mẫu từ POS để thử giao diện:
            </label>
            <textarea
              id="student-qr-paste"
              rows={3}
              value={pastedQr}
              onChange={(e) => setPastedQr(e.target.value)}
              aria-describedby="payload-feedback"
              className="mono-textarea"
            />
            <div className="qr-paste-actions">
              <span id="payload-feedback" className="muted-line" role="status">
                {payloadMatches
                  ? "Nội dung khớp phiếu mẫu. Chưa xác minh chữ ký."
                  : "Nội dung chưa hợp lệ. Nút yêu cầu ký đang bị khóa."}
              </span>
              <button
                type="button"
                className="secondary-btn"
                onClick={resetPreview}
              >
                Lấy lại phiếu mẫu
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Nội dung theo trạng thái xem thử */}
      {uiState === "loading" ? (
        <section
          className="surface-panel state-panel"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="status-banner banner-loading">
            <span className="spinner" aria-hidden="true" />
            <div>
              <h2>Đang kiểm tra phiếu gửi xe và thẻ sinh viên của bạn…</h2>
              <p>
                Vui lòng giữ màn hình trong giây lát, hệ thống đang tính mức
                giảm giá tự động.
              </p>
            </div>
          </div>
          <div className="skeleton-list" aria-hidden="true">
            <div className="skeleton-row" />
            <div className="skeleton-row" />
            <div className="skeleton-row short" />
          </div>
        </section>
      ) : null}

      {uiState === "error" ? (
        <section className="surface-panel state-panel error-panel" role="alert">
          <div className="error-header">
            <span className="error-code-badge">
              Tình huống mẫu · {activeError.code}
            </span>
            <h2>{activeError.studentTitle}</h2>
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
        </section>
      ) : null}

      {uiState === "waiting" ? (
        <section
          className="surface-panel invoice-preview-panel"
          aria-label="Chi tiết số tiền cần trả"
        >
          <div className="invoice-preview-head">
            <div>
              <h2>{invoice.meta.serviceName}</h2>
              <p className="muted-line">Nơi thu: {invoice.meta.merchantName}</p>
            </div>
            <span className="timer-badge tabular-value">Hạn mẫu: 05:00</span>
          </div>

          <div className="transaction-context">
            <span>
              Mạng: {campusNetwork.name} · Chain {campusNetwork.chainId}
            </span>
            <span>Địa chỉ nhận mẫu:</span>
            <code className="mono-value">{invoice.invoice.merchant}</code>
          </div>
          <dl className="price-breakdown">
            <div className="price-row">
              <dt>Giá vé niêm yết</dt>
              <dd className="tabular-value">
                {formatCampusWei(quote.originalAmountWei)}
              </dd>
            </div>
            <div className="price-row discount-row">
              <dt>
                Ưu đãi thẻ sinh viên (
                {wallet.sbt.hasValidCard ? "Giảm 10%" : "Không có ưu đãi"})
              </dt>
              <dd className="tabular-value">
                {quote.discountBps > 0
                  ? `-${formatCampusWei(quote.discountAmountWei)}`
                  : "0 CAMPUS"}
              </dd>
            </div>
            <div className="price-row total-row">
              <dt>Số tiền bạn cần trả</dt>
              <dd className="tabular-value total-amount">
                {formatCampusWei(quote.paidAmountWei)}
              </dd>
            </div>
            <div className="price-row gas-row">
              <dt>Phí gas mẫu (tách riêng)</dt>
              <dd className="tabular-value">
                ~{formatCampusWei(quote.estimatedGasWei)}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {uiState === "awaiting-signature" || uiState === "pending" ? (
        <section className="surface-panel state-panel" aria-live="polite">
          <span className="timer-badge">Tình huống mô phỏng</span>
          <h2>
            {uiState === "awaiting-signature"
              ? "Đang chờ bạn xác nhận ký"
              : "Đang chờ xác nhận giao dịch"}
          </h2>
          <p>
            {uiState === "awaiting-signature"
              ? "Kiểm tra số tiền và đích nhận. Trong bản tích hợp, ví sẽ yêu cầu bạn xác nhận ở bước này."
              : "Chưa có receipt hợp lệ thì chưa báo thanh toán thành công. Bản xem thử không gửi giao dịch."}
          </p>
          <div className="transaction-context">
            <strong>
              {formatCampusWei(quote.paidAmountWei)} ·{" "}
              {invoice.meta.merchantName}
            </strong>
            <code className="mono-value">{invoice.invoice.merchant}</code>
            <span>
              {campusNetwork.name} · Chain {campusNetwork.chainId}
            </span>
          </div>
          {uiState === "awaiting-signature" ? (
            <div className="inline-actions">
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
            </div>
          ) : (
            <div className="inline-actions">
              <button
                type="button"
                className="secondary-btn"
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
            </div>
          )}
        </section>
      ) : null}

      {uiState === "receipt" ? (
        <section className="surface-panel receipt-panel" aria-live="polite">
          <div className="receipt-header">
            <span className="verified-badge">
              BIÊN LAI MẪU · KHÔNG PHẢI GIAO DỊCH THẬT
            </span>
            <h2>Xem trước biên lai thanh toán</h2>
            <p className="muted-line">{receipt.verifiedAtLabel}</p>
          </div>

          <dl className="price-breakdown">
            <div className="price-row">
              <dt>Dịch vụ</dt>
              <dd>{invoice.meta.serviceName}</dd>
            </div>
            <div className="price-row">
              <dt>Nơi thu</dt>
              <dd>{invoice.meta.merchantName}</dd>
            </div>
            <div className="price-row">
              <dt>Giá vé gốc</dt>
              <dd className="tabular-value">
                {formatCampusWei(receipt.originalAmountWei)}
              </dd>
            </div>
            <div className="price-row discount-row">
              <dt>Đã giảm nhờ thẻ sinh viên</dt>
              <dd className="tabular-value">
                {receipt.tier === 1
                  ? `-${formatCampusWei(receipt.discountAmountWei)}`
                  : "0 CAMPUS"}
              </dd>
            </div>
            <div className="price-row total-row">
              <dt>Số tiền thanh toán mẫu</dt>
              <dd className="tabular-value total-amount">
                {formatCampusWei(receipt.paidAmountWei)}
              </dd>
            </div>
            <div className="price-row gas-row">
              <dt>Phí giao dịch đã tính riêng</dt>
              <dd className="tabular-value">
                {formatCampusWei(receipt.gasFeeWei)}
              </dd>
            </div>
          </dl>

          <p className="replay-guard-note">
            Đây là biên lai giả lập cho cùng hóa đơn với POS. Hai màn hình chưa
            đồng bộ qua API. Khi tích hợp, chỉ xác nhận sau receipt thành công
            và event khớp hóa đơn.
          </p>
        </section>
      ) : null}

      {/* Thanh nút bấm chính cố định ở đáy màn hình điện thoại (Sticky CTA Dock) */}
      <div
        className="student-sticky-cta"
        role="region"
        aria-label="Nút trả tiền nhanh"
      >
        <div className="sticky-cta-summary">
          <span className="sticky-cta-label">
            {uiState === "receipt"
              ? "Biên lai mẫu"
              : uiState === "error"
                ? "Chưa thể tiếp tục"
                : "Cần thanh toán"}
          </span>
          <strong className="tabular-value sticky-cta-amount">
            {uiState === "receipt"
              ? formatCampusWei(receipt.paidAmountWei)
              : formatCampusWei(quote.paidAmountWei)}
          </strong>
        </div>

        {uiState === "waiting" ? (
          <button
            type="button"
            className="primary-cta-btn"
            disabled={!payloadMatches}
            onClick={() => setUiState("awaiting-signature")}
          >
            Thử bước ký · {formatCampusWei(quote.paidAmountWei)}
          </button>
        ) : null}

        {uiState === "awaiting-signature" || uiState === "pending" ? (
          <button type="button" className="primary-cta-btn" disabled>
            {uiState === "pending"
              ? "Chờ xác nhận · Mô phỏng"
              : "Chờ ký · Mô phỏng"}
          </button>
        ) : null}

        {uiState === "loading" ? (
          <button type="button" className="primary-cta-btn" disabled>
            Đang kiểm tra phiếu…
          </button>
        ) : null}

        {uiState === "error" ? (
          <button
            type="button"
            className="primary-cta-btn"
            onClick={resetPreview}
          >
            {activeError.actionLabelStudent}
          </button>
        ) : null}

        {uiState === "receipt" ? (
          <button type="button" className="primary-cta-btn" disabled>
            Đang xem biên lai mẫu
          </button>
        ) : null}
      </div>

      {/* Chi tiết fixture phục vụ đối chiếu khi tích hợp */}
      <section className="secondary-modules" aria-label="Chi tiết dữ liệu mẫu">
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
            {uiState === "receipt" && (
              <div className="tx-proof-box">
                <span>
                  Hash mẫu · Block #{receipt.blockNumber} · Chưa xác minh
                  on-chain
                </span>
                <CopyButton
                  key={walletKind}
                  value={receipt.txHash}
                  label="Sao chép hash mẫu"
                />
                <code className="tx-hash-code">{receipt.txHash}</code>
              </div>
            )}
          </div>
        </details>
      </section>
    </div>
  );
}
