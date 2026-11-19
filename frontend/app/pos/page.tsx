"use client";

import QRCode from "qrcode";
import { campusNetwork } from "@intracampus/network";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CopyButton, DemoControls } from "../demo-controls";
import { InvoiceForm } from "./InvoiceForm";
import PosShiftLedger from "./PosShiftLedger";
import PageHeading from "../components/PageHeading";
import Icon from "../components/Icon";
import {
  calculateInvoiceQuote,
  type DemoErrorKind,
  demoErrorScenarios,
  demoPosServices,
  demoPosSessionHistory,
  type DemoUiState,
  type DemoWalletKind,
  demoWalletProfiles,
  formatCampusWei,
  getDemoReceiptFixture,
  sharedParkingInvoiceEnvelope,
  sharedQrPayloadString,
  shortenHex,
} from "../demo-fixtures";

function InvoiceQrPlaceholder({ code }: { code: string }) {
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(sharedQrPayloadString, {
      errorCorrectionLevel: "Q",
      margin: 2,
      width: 280,
    })
      .then((url) => {
        if (active) setQrSrc(url);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return qrSrc ? (
    <div className="qr-image-wrap demo-qr-wrap">
      <img
        src={qrSrc}
        alt={`Mã QR mẫu cho phiếu ${code}`}
        width={240}
        height={240}
      />
    </div>
  ) : (
    <div
      className="qr-placeholder"
      role="img"
      aria-label="Vùng QR mẫu, đang khởi tạo"
    >
      <span aria-hidden="true">QR</span>
      <strong>Đang tạo mã QR mẫu…</strong>
    </div>
  );
}

function PointOfSaleDemo() {
  const [uiState, setUiState] = useState<DemoUiState>("waiting");
  const [walletKind, setWalletKind] = useState<DemoWalletKind>("sbt");
  const [errorKind, setErrorKind] = useState<DemoErrorKind>("expired");
  const [autoRenewDemo, setAutoRenewDemo] = useState(true);
  const [demoCycle, setDemoCycle] = useState(0);
  const [demoCountdown, setDemoCountdown] = useState<number | null>(null);
  const [demoLastPaid, setDemoLastPaid] = useState<{ code: string; paidAmountWei: string } | null>(null);

  const invoice = sharedParkingInvoiceEnvelope;
  const activeInvoiceCode =
    demoCycle === 0
      ? invoice.meta.invoiceCode
      : `PK-DEMO-${String(1048 + demoCycle)}`;
  const sbtQuote = calculateInvoiceQuote(
    invoice.invoice.amount,
    demoWalletProfiles.sbt.sbt.discountBps,
  );
  const standardQuote = calculateInvoiceQuote(
    invoice.invoice.amount,
    demoWalletProfiles.standard.sbt.discountBps,
  );
  const receipt = getDemoReceiptFixture(walletKind);
  const activeError = demoErrorScenarios[errorKind];

  useEffect(() => {
    if (uiState !== "receipt" || !autoRenewDemo) {
      setDemoCountdown(null);
      return;
    }
    setDemoCountdown(4);
    const interval = window.setInterval(() => {
      setDemoCountdown((prev) => (prev !== null && prev > 1 ? prev - 1 : prev));
    }, 1000);
    const timer = window.setTimeout(() => {
      setDemoLastPaid({
        code: activeInvoiceCode,
        paidAmountWei: receipt.paidAmountWei,
      });
      setDemoCycle((prev) => prev + 1);
      setDemoCountdown(null);
      setUiState("waiting");
    }, 4000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timer);
    };
  }, [uiState, autoRenewDemo, activeInvoiceCode, receipt.paidAmountWei]);

  return (
    <div className="pos-shell">
      <DemoControls
        state={uiState}
        wallet={walletKind}
        error={errorKind}
        onState={setUiState}
        onWallet={setWalletKind}
        onError={setErrorKind}
      />

      {/* Đầu trang Màn hình thu tiền nhà xe */}
      <header className="pos-header-bar surface-panel">
        <div>
          <h2 className="screen-title">
            Điểm thu · {invoice.meta.merchantName}
          </h2>
          <p className="screen-subtitle">
            Xem hóa đơn, số tiền và trạng thái thu tiền tại bãi xe
          </p>
        </div>
        <div className="pos-header-badges">
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
          <span className="merchant-pill">
            Trạm trực: <strong>{invoice.meta.merchantName}</strong>
          </span>
        </div>
      </header>

      {/* Bố cục ngang 2 cột: Cột trái cho bác bảo vệ bấm nút, Cột phải hiện mã QR & kết quả */}
      <div className="pos-workbench-grid">
        {/* Cột trái: Nút chọn loại vé và tạo mã mới */}
        <aside
          className="surface-panel pos-sidebar"
          aria-label="Chọn loại vé gửi xe"
        >
          <h2>1. Chọn loại vé cần thu</h2>
          <p className="muted-line">
            Giá gốc từ danh mục mẫu. Ưu đãi được tính theo thẻ sinh viên, không
            do nhân viên chọn.
          </p>

          <div className="service-list" aria-label="Danh sách loại vé giữ xe">
            {demoPosServices.map((srv) => (
              <label
                key={srv.serviceId}
                className={
                  srv.active ? "service-item active" : "service-item disabled"
                }
              >
                <input
                  type="radio"
                  name="service"
                  checked={srv.active}
                  disabled={!srv.active}
                  readOnly
                  aria-label={srv.serviceName}
                />
                <div className="service-item-top">
                  <strong>{srv.serviceName}</strong>
                  <span className="tabular-value service-price">
                    {formatCampusWei(srv.amountWei)}
                  </span>
                </div>
                <span className="muted-line">{srv.subtitle}</span>
              </label>
            ))}
          </div>

          <div className="pos-policy-box">
            <h3>Số tiền máy sẽ tự động thu</h3>
            <dl className="compact-dl">
              <div>
                <dt>Sinh viên có thẻ trường (-10%)</dt>
                <dd className="tabular-value highlight-amount">
                  {formatCampusWei(sbtQuote.paidAmountWei)}
                </dd>
              </div>
              <div>
                <dt>Khách ngoài / Chưa có thẻ</dt>
                <dd className="tabular-value">
                  {formatCampusWei(standardQuote.paidAmountWei)}
                </dd>
              </div>
            </dl>
          </div>

          <div className="pos-sidebar-actions">
            <button
              type="button"
              className={`pos-autorenew-toggle ${autoRenewDemo ? "is-on" : ""}`}
              aria-pressed={autoRenewDemo}
              onClick={() => setAutoRenewDemo((prev) => !prev)}
            >
              <span className="autorenew-dot" aria-hidden="true" />
              Tự làm mới QR khi thu xong:{" "}
              <strong>{autoRenewDemo ? "Đang bật" : "Đang tắt"}</strong>
            </button>
            <button
              type="button"
              className="primary-cta-btn"
              onClick={() => {
                setDemoCountdown(null);
                setUiState("waiting");
              }}
            >
              Đặt lại phiếu mẫu
            </button>
            <CopyButton
              value={sharedQrPayloadString}
              label="Sao chép phiếu mẫu"
              className="secondary-btn full-width"
            />
            <details className="payload-panel">
              <summary>Nội dung phiếu mẫu</summary>
              <pre className="tx-hash-code">{sharedQrPayloadString}</pre>
            </details>
          </div>
        </aside>

        {/* Cột phải: Màn hình chính hiển thị Mã QR hoặc Thông báo Cho Xe Qua Cổng */}
        <section
          className="surface-panel pos-main-stage"
          aria-label="Màn hình quét mã và báo kết quả thu tiền"
          aria-live="polite"
        >
          {uiState === "loading" ? (
            <div className="pos-stage-loading" aria-busy="true">
              <div className="status-banner banner-loading">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <h2>Đang tải dữ liệu hóa đơn mẫu…</h2>
                  <p>
                    Dữ liệu đang được tải trong tình huống mô phỏng. Chọn “Hóa
                    đơn” để quay lại bản xem trước.
                  </p>
                </div>
              </div>
              <div className="skeleton-qr-grid" aria-hidden="true">
                <div className="skeleton-qr-box" />
                <div className="skeleton-list">
                  <div className="skeleton-row" />
                  <div className="skeleton-row" />
                  <div className="skeleton-row short" />
                </div>
              </div>
            </div>
          ) : null}

          {uiState === "waiting" ? (
            <div className="pos-stage-waiting">
              {demoLastPaid ? (
                <div className="pos-last-paid-banner" role="status">
                  <div className="last-paid-copy">
                    <span className="last-paid-check" aria-hidden="true">
                      <Icon name="check" />
                    </span>
                    <div>
                      <strong>
                        Lượt mẫu vừa qua cổng ({demoLastPaid.code}): Đã thu{" "}
                        {formatCampusWei(demoLastPaid.paidAmountWei)}
                      </strong>
                      <p>
                        Mã QR mẫu bên dưới đã tự động làm mới (
                        {activeInvoiceCode}) — sẵn sàng cho xe tiếp theo quét.
                      </p>
                    </div>
                  </div>
                  <div className="last-paid-actions">
                    <button
                      type="button"
                      className="text-action-btn"
                      onClick={() => setDemoLastPaid(null)}
                    >
                      Ẩn
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="pos-stage-top">
                <div>
                  <span className="live-waiting-badge">
                    <span className="pulse-dot" aria-hidden="true" />
                    Hóa đơn mẫu · Chờ thanh toán
                  </span>
                  <h2>{invoice.meta.serviceName}</h2>
                  <p className="muted-line">
                    Mã số phiếu:{" "}
                    <code className="inline-code">
                      {activeInvoiceCode}
                    </code>
                  </p>
                </div>
                <div className="pos-countdown-box">
                  <span className="countdown-label">Thời hạn hóa đơn mẫu</span>
                  <strong className="tabular-value countdown-clock">
                    05:00
                  </strong>
                  <span className="countdown-sub">
                    Mốc mẫu · Không đếm ngược
                  </span>
                </div>
              </div>

              <div className="pos-qr-showcase">
                <div className="qr-frame">
                  <InvoiceQrPlaceholder code={activeInvoiceCode} />
                  <span className="qr-caption">
                    Dùng “Sao chép phiếu mẫu” để thử ô nhập trên trang Sinh
                    viên.
                  </span>
                </div>

                <div className="pos-invoice-details">
                  <dl className="price-breakdown">
                    <div className="price-row">
                      <dt>Giá vé niêm yết</dt>
                      <dd className="tabular-value">
                        {formatCampusWei(invoice.invoice.amount)}
                      </dd>
                    </div>
                    <div className="price-row discount-row">
                      <dt>Nếu khách là Sinh viên trường (-10%)</dt>
                      <dd className="tabular-value">
                        Chỉ thu {formatCampusWei(sbtQuote.paidAmountWei)}
                      </dd>
                    </div>
                    <div className="price-row">
                      <dt>Nếu khách vãng lai</dt>
                      <dd className="tabular-value">
                        Thu đủ {formatCampusWei(standardQuote.paidAmountWei)}
                      </dd>
                    </div>
                  </dl>

                  <div className="pos-verification-notice">
                    <strong>Lưu ý cho bác bảo vệ:</strong>
                    <p>
                      Khi tích hợp, chỉ xác nhận đã thu tiền sau khi receipt
                      thành công và sự kiện khớp hóa đơn. Biên lai ở bản xem thử
                      không dùng để cho xe qua cổng.
                    </p>
                  </div>

                  <div className="inline-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => setUiState("awaiting-signature")}
                    >
                      Thử trạng thái chờ ký
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {uiState === "error" ? (
            <div className="pos-stage-error error-panel" role="alert">
              <div className="error-header">
                <span className="error-code-badge">
                  TÌNH HUỐNG MẪU · {activeError.code}
                </span>
                <h2>{activeError.posTitle}</h2>
              </div>
              <p className="error-body">{activeError.posMessage}</p>

              <div className="next-step-box">
                <strong>Bác bảo vệ chỉ cần làm bước này:</strong>
                <p>{activeError.nextStepPos}</p>
              </div>

              <div className="inline-actions">
                <button
                  type="button"
                  className="primary-cta-btn"
                  onClick={() => setUiState("waiting")}
                >
                  {activeError.actionLabelPos}
                </button>
              </div>
            </div>
          ) : null}

          {uiState === "awaiting-signature" || uiState === "pending" ? (
            <div className="state-panel" aria-live="polite">
              <span className="timer-badge">Tình huống mô phỏng</span>
              <h2>
                {uiState === "awaiting-signature"
                  ? "Chờ sinh viên xác nhận trong ví"
                  : "Chờ xác nhận từ blockchain"}
              </h2>
              {uiState === "pending" ? (
                <div className="l1-shimmer-track" aria-hidden="true">
                  <div className="l1-shimmer-bar" />
                </div>
              ) : null}
              <p>
                Không xác nhận đã thu tiền khi giao dịch chưa có receipt hợp lệ.
                Bản xem thử không kết nối ví hoặc RPC.
              </p>
              <div className="inline-actions">
                {uiState === "awaiting-signature" ? (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setUiState("pending")}
                  >
                    Thử trạng thái chờ xác nhận
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setUiState("receipt")}
                  >
                    Xem biên lai mẫu
                  </button>
                )}
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
            </div>
          ) : null}

          {uiState === "receipt" ? (
            <div className="pos-stage-receipt">
              <div className="pos-receipt-banner">
                <div>
                  <span className="verified-badge">
                    BIÊN LAI MẪU · CHƯA XÁC MINH ON-CHAIN
                  </span>
                  <h2>Xem trước kết quả thu tiền</h2>
                  <p className="muted-line">{receipt.verifiedAtLabel}</p>
                </div>
                <div className="pos-collected-box">
                  <span>Số tiền thu mẫu</span>
                  <strong className="tabular-value collected-amount">
                    {formatCampusWei(receipt.paidAmountWei)}
                  </strong>
                </div>
              </div>

              <div className="pos-receipt-grid">
                <dl className="price-breakdown">
                  <div className="price-row">
                    <dt>Người trả tiền</dt>
                    <dd>
                      <strong>{receipt.payerName}</strong>
                    </dd>
                  </div>
                  <div className="price-row">
                    <dt>Giá vé gốc</dt>
                    <dd className="tabular-value">
                      {formatCampusWei(receipt.originalAmountWei)}
                    </dd>
                  </div>
                  <div className="price-row discount-row">
                    <dt>
                      Ưu đãi thẻ sinh viên (
                      {receipt.tier === 1 ? "Đã giảm 10%" : "Không giảm"})
                    </dt>
                    <dd className="tabular-value">
                      {receipt.tier === 1
                        ? `-${formatCampusWei(receipt.discountAmountWei)}`
                        : "0 CAMPUS"}
                    </dd>
                  </div>
                  <div className="price-row total-row">
                    <dt>Tổng thực thu vào quỹ nhà xe</dt>
                    <dd className="tabular-value total-amount">
                      {formatCampusWei(receipt.paidAmountWei)}
                    </dd>
                  </div>
                </dl>

                <div className="pos-verification-notice">
                  <strong>Trạng thái vé xe:</strong>
                  <p>
                    Phiếu <strong>{activeInvoiceCode}</strong> đang hiển thị
                    biên lai giả lập.{" "}
                    {demoCountdown !== null ? (
                      <>
                        Hệ thống sẽ tự động cấp mã QR mới cho xe tiếp theo sau{" "}
                        <strong>{demoCountdown}s</strong>…
                      </>
                    ) : (
                      <>
                        Bấm nút bên dưới để phát hành mã QR mẫu cho lượt tiếp
                        theo.
                      </>
                    )}
                  </p>
                </div>
              </div>

              <div className="inline-actions">
                <button
                  type="button"
                  className="primary-cta-btn"
                  onClick={() => {
                    setDemoLastPaid({
                      code: activeInvoiceCode,
                      paidAmountWei: receipt.paidAmountWei,
                    });
                    setDemoCycle((prev) => prev + 1);
                    setDemoCountdown(null);
                    setUiState("waiting");
                  }}
                >
                  {demoCountdown !== null
                    ? "Làm mới QR mẫu ngay"
                    : "Tạo lượt QR mẫu tiếp theo"}
                </button>
                {demoCountdown !== null ? (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => {
                      setAutoRenewDemo(false);
                      setDemoCountdown(null);
                    }}
                  >
                    Giữ biên lai mẫu
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Mục thông số kỹ thuật thu gọn dành riêng cho Ban giám khảo / Kỹ thuật viên */}
          <details className="module-accordion" style={{ marginTop: "0.5rem" }}>
            <summary>
              <span>Thông tin fixture</span>
              <span className="muted-tag">Chain {campusNetwork.chainId}</span>
            </summary>
            <div className="accordion-content">
              <dl className="meta-grid">
                <div>
                  <dt>Ví nhận tiền nhà xe</dt>
                  <dd className="mono-value">
                    {shortenHex(invoice.invoice.merchant, 10, 6)}
                  </dd>
                </div>
                <div>
                  <dt>Địa chỉ signer POS mẫu</dt>
                  <dd className="mono-value">
                    {shortenHex(invoice.signer, 10, 6)}
                  </dd>
                </div>
                {uiState === "receipt" && (
                  <>
                    <div>
                      <dt>Ví trả mẫu</dt>
                      <dd className="mono-value">
                        {shortenHex(receipt.payer, 10, 6)}
                      </dd>
                    </div>
                    <div>
                      <dt>Block xác nhận</dt>
                      <dd className="tabular-value">
                        #{receipt.blockNumber} (Chain ID {receipt.chainId}) ·
                        Mẫu
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              {uiState === "receipt" && (
                <div className="tx-proof-box">
                  <span>Hash giao dịch mẫu · Chưa xác minh on-chain</span>
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
      <PosShiftLedger
        entries={demoPosSessionHistory}
        activeInvoiceId={invoice.invoice.invoiceId}
        demoMode
      />
    </div>
  );
}

export default function PointOfSalePage() {
  const [mode, setMode] = useState<"live" | "demo">("live");
  return <>
    <PageHeading eyebrow="KHÔNG GIAN ĐIỂM THU" title="Mỗi lượt thu, thật rõ ràng." description="Tạo hóa đơn QR và theo dõi biên lai trong cùng một không gian." icon="store">
      <span className="page-context-tag"><Icon name="store" />Bãi xe campus</span>
      <Link className="secondary-btn" href="/staff/canteen">Quầy bếp nhà ăn →</Link>
    </PageHeading>
    <div className="workspace-toolbar">
      <p className="workspace-caption">Đơn giản cho điểm thu. Thuận tiện cho sinh viên.</p>
      <div className="mode-switch-wrapper">
        <span className="mode-switch-kicker">
          <span className={`mode-status-dot ${mode === "live" ? "dot-live" : "dot-demo"}`} aria-hidden="true" />
          {mode === "live" ? "Avalanche L1 · Chain 20261" : "Bản minh họa"}
        </span>
        <div className="student-mode-switch" role="group" aria-label="Chế độ POS">
          <button type="button" className="secondary-btn" aria-pressed={mode === "live"} onClick={() => setMode("live")}>POS thật</button>
          <button type="button" className="secondary-btn" aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>Xem bản minh họa</button>
        </div>
      </div>
    </div>
    {mode === "live" ? <div className="pos-live-workspace"><InvoiceForm /></div> : <PointOfSaleDemo />}
  </>;
}
