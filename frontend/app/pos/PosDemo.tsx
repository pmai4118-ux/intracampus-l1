"use client";

import { campusNetwork } from "@intracampus/network";
import { useEffect, useState, type FormEvent } from "react";
import { renderInvoiceQr, type InvoiceQrImage } from "../../lib/invoice-qr";
import HashChip from "../components/HashChip";
import Icon from "../components/Icon";
import { CopyButton, DemoControls } from "../demo-controls";
import {
  calculateInvoiceQuote,
  demoErrorScenarios,
  demoPosSessionHistory,
  demoWalletProfiles,
  formatCampusWei,
  getDemoReceiptFixture,
  sharedParkingInvoiceEnvelope,
  sharedQrPayloadString,
  shortenHex,
  type DemoErrorKind,
  type DemoUiState,
  type DemoWalletKind,
  type PosSessionLedgerEntry,
} from "../demo-fixtures";
import PosShiftLedger from "./PosShiftLedger";

const AUTO_RENEW_SECONDS = 4;

function buildCycleInvoiceId(cycle: number): string {
  if (cycle === 0) return sharedParkingInvoiceEnvelope.invoice.invoiceId;
  const suffix = (0x69b1 + cycle).toString(16).padStart(4, "0");
  return `${sharedParkingInvoiceEnvelope.invoice.invoiceId.slice(0, -4)}${suffix}`;
}

function buildCycleInvoiceCode(cycle: number): string {
  return cycle === 0
    ? sharedParkingInvoiceEnvelope.meta.invoiceCode
    : `PK-DEMO-${String(1048 + cycle)}`;
}

function buildCycleQrPayload(cycle: number): string {
  if (cycle === 0) return sharedQrPayloadString;
  return JSON.stringify({
    ...sharedParkingInvoiceEnvelope,
    invoice: {
      ...sharedParkingInvoiceEnvelope.invoice,
      invoiceId: buildCycleInvoiceId(cycle),
    },
    meta: {
      ...sharedParkingInvoiceEnvelope.meta,
      invoiceCode: buildCycleInvoiceCode(cycle),
    },
  });
}

type LastPaidDemoSummary = {
  invoiceId: string;
  code: string;
  paidAmountWei: string;
  tier: 0 | 1;
  blockNumber: number;
};

export default function PosDemo({
  onBackToLive,
}: {
  onBackToLive?: () => void;
} = {}) {
  const [uiState, setUiState] = useState<DemoUiState>("waiting");
  const [walletKind, setWalletKind] = useState<DemoWalletKind>("sbt");
  const [errorKind, setErrorKind] = useState<DemoErrorKind>("expired");
  const [autoRenewDemo, setAutoRenewDemo] = useState(true);
  const [holdAutoRenew, setHoldAutoRenew] = useState(false);
  const [demoCycle, setDemoCycle] = useState(0);
  const [activeInvoiceId, setActiveInvoiceId] = useState(
    sharedParkingInvoiceEnvelope.invoice.invoiceId,
  );
  const [shiftHistory, setShiftHistory] = useState<PosSessionLedgerEntry[]>(
    () => demoPosSessionHistory,
  );
  const [demoCountdown, setDemoCountdown] = useState<number | null>(null);
  const [demoLastPaid, setDemoLastPaid] = useState<LastPaidDemoSummary | null>(
    null,
  );
  const [qrImage, setQrImage] = useState<InvoiceQrImage | null>(null);
  const [copiedPayload, setCopiedPayload] = useState(false);
  const [lookupId, setLookupId] = useState(
    sharedParkingInvoiceEnvelope.invoice.invoiceId,
  );
  const [lookupTxHash, setLookupTxHash] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);

  const invoice = sharedParkingInvoiceEnvelope;
  const baseReceipt = getDemoReceiptFixture(walletKind);
  const activeError = demoErrorScenarios[errorKind];
  const isWrongChain = uiState === "error" && errorKind === "wrong-chain";
  const currentCycleId = buildCycleInvoiceId(demoCycle);

  const activeEntry =
    shiftHistory.find(
      (item) => item.invoiceId.toLowerCase() === activeInvoiceId.toLowerCase(),
    ) ?? shiftHistory[0];
  const isCurrentCycle =
    activeEntry.invoiceId.toLowerCase() === currentCycleId.toLowerCase();

  const activeCycleMatch = /^PK-DEMO-(\d+)$/.exec(activeEntry.invoiceCode);
  const activeQrPayload =
    activeEntry.invoiceId.toLowerCase() ===
    invoice.invoice.invoiceId.toLowerCase()
      ? sharedQrPayloadString
      : activeCycleMatch
        ? buildCycleQrPayload(Number(activeCycleMatch[1]) - 1048)
        : JSON.stringify({
            ...invoice,
            invoice: { ...invoice.invoice, invoiceId: activeEntry.invoiceId },
            meta: { ...invoice.meta, invoiceCode: activeEntry.invoiceCode },
          });

  const sbtQuote = calculateInvoiceQuote(
    activeEntry.amountWei,
    demoWalletProfiles.sbt.sbt.discountBps,
  );
  const activeTier: 0 | 1 =
    !isCurrentCycle && activeEntry.status === "paid" && activeEntry.tier !== null
      ? (activeEntry.tier as 0 | 1)
      : walletKind === "sbt"
        ? 1
        : 0;
  const activeReceiptQuote = calculateInvoiceQuote(
    activeEntry.amountWei,
    activeTier === 1 ? 1000 : 0,
  );
  const activePaidWei =
    !isCurrentCycle && activeEntry.status === "paid" && activeEntry.paidAmountWei
      ? activeEntry.paidAmountWei
      : activeReceiptQuote.paidAmountWei;
  const activeDiscountWei =
    activeTier === 1
      ? (BigInt(activeEntry.amountWei) - BigInt(activePaidWei)).toString()
      : "0";
  const activeTxHash =
    !isCurrentCycle && activeEntry.txHash ? activeEntry.txHash : baseReceipt.txHash;
  const activePayer =
    activeTier === 1
      ? demoWalletProfiles.sbt.address
      : demoWalletProfiles.standard.address;

  useEffect(() => {
    setLookupId(activeEntry.invoiceId);
    setLookupTxHash(activeEntry.txHash ?? "");
    setLookupError(null);
  }, [activeEntry.invoiceId, activeEntry.txHash]);

  useEffect(() => {
    if (!copiedPayload) return;
    const timer = window.setTimeout(() => setCopiedPayload(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedPayload]);

  useEffect(() => {
    let active = true;
    setQrImage(null);
    void renderInvoiceQr(activeQrPayload)
      .then((image) => {
        if (active) setQrImage(image);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [activeQrPayload]);

  useEffect(() => {
    if (!isCurrentCycle) return;
    setShiftHistory((prev) =>
      prev.map((entry) => {
        if (entry.invoiceId.toLowerCase() !== currentCycleId.toLowerCase())
          return entry;
        if (uiState === "receipt") {
          return {
            ...entry,
            status: "paid",
            paidAmountWei: baseReceipt.paidAmountWei,
            tier: baseReceipt.tier,
            txHash: baseReceipt.txHash,
          };
        }
        if (uiState === "error" && errorKind === "expired") {
          return {
            ...entry,
            status: "expired",
            paidAmountWei: null,
            tier: null,
            txHash: null,
          };
        }
        return {
          ...entry,
          status: "pending",
          paidAmountWei: null,
          tier: null,
          txHash: null,
        };
      }),
    );
  }, [
    isCurrentCycle,
    currentCycleId,
    uiState,
    errorKind,
    baseReceipt.paidAmountWei,
    baseReceipt.tier,
    baseReceipt.txHash,
  ]);

  function issueNextDemoInvoice(fromPaidReceipt = false) {
    const nextCycle = demoCycle + 1;
    const nextId = buildCycleInvoiceId(nextCycle);
    const nextCode = buildCycleInvoiceCode(nextCycle);
    if (fromPaidReceipt) {
      setDemoLastPaid({
        invoiceId: activeEntry.invoiceId,
        code: activeEntry.invoiceCode,
        paidAmountWei: activePaidWei,
        tier: activeTier,
        blockNumber: baseReceipt.blockNumber,
      });
    }
    const newEntry: PosSessionLedgerEntry = {
      invoiceId: nextId,
      invoiceCode: nextCode,
      serviceName: invoice.meta.serviceName,
      amountWei: invoice.invoice.amount,
      paidAmountWei: null,
      status: "pending",
      tier: null,
      txHash: null,
      createdAt: Date.now(),
    };
    setShiftHistory((prev) => [newEntry, ...prev].slice(0, 30));
    setDemoCycle(nextCycle);
    setActiveInvoiceId(nextId);
    setHoldAutoRenew(false);
    setDemoCountdown(null);
    setUiState("waiting");
  }

  useEffect(() => {
    if (uiState !== "receipt" || !autoRenewDemo || holdAutoRenew) {
      setDemoCountdown(null);
      return;
    }
    setDemoCountdown(AUTO_RENEW_SECONDS);
    const interval = window.setInterval(() => {
      setDemoCountdown((prev) => (prev !== null && prev > 1 ? prev - 1 : prev));
    }, 1000);
    const timer = window.setTimeout(() => {
      issueNextDemoInvoice(true);
    }, AUTO_RENEW_SECONDS * 1000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState, autoRenewDemo, holdAutoRenew, activeEntry.invoiceId]);

  function handleStateChange(nextState: DemoUiState) {
    if (nextState === "receipt") {
      setHoldAutoRenew(false);
    }
    setUiState(nextState);
  }

  function selectHistoryInvoice(targetId: string) {
    const found = shiftHistory.find(
      (item) => item.invoiceId.toLowerCase() === targetId.toLowerCase(),
    );
    if (!found) return;
    setActiveInvoiceId(found.invoiceId);
    setDemoCountdown(null);
    if (found.status === "paid") {
      setHoldAutoRenew(true);
      setUiState("receipt");
    } else if (found.status === "expired") {
      setHoldAutoRenew(true);
      setErrorKind("expired");
      setUiState("error");
    } else {
      setHoldAutoRenew(false);
      setUiState("waiting");
    }
  }

  function handleRecoverySubmit(event: FormEvent) {
    event.preventDefault();
    setLookupError(null);
    const idQuery = lookupId.trim().toLowerCase();
    const txQuery = lookupTxHash.trim().toLowerCase();
    const found = shiftHistory.find(
      (item) =>
        (idQuery && item.invoiceId.toLowerCase() === idQuery) ||
        (txQuery && (item.txHash ?? "").toLowerCase() === txQuery),
    );
    if (!found) {
      setLookupError(
        "Không tìm thấy hóa đơn mẫu khớp trong ca trực. Hãy chọn một dòng từ Nhật ký phiên bên dưới.",
      );
      return;
    }
    selectHistoryInvoice(found.invoiceId);
  }

  async function copyPayload() {
    try {
      await navigator.clipboard.writeText(activeQrPayload);
      setCopiedPayload(true);
    } catch {
      /* Người dùng vẫn có thể mở phần payload thủ công bên dưới. */
    }
  }

  const statusHeading: Record<DemoUiState, string> = {
    waiting: "Chờ thanh toán / xác minh",
    loading: "Đang tra cứu hóa đơn mẫu",
    "awaiting-signature": "Chờ sinh viên xác nhận trong ví",
    pending: "Chờ xác nhận từ blockchain",
    error: activeError.posTitle,
    receipt: "Đã xác minh thanh toán (Mẫu)",
  };

  const ttlBarPct =
    uiState === "error" && errorKind === "expired"
      ? 14
      : uiState === "receipt"
        ? 100
        : 84;

  return (
    <>
      <DemoControls
        state={uiState}
        wallet={walletKind}
        error={errorKind}
        onState={handleStateChange}
        onWallet={setWalletKind}
        onError={setErrorKind}
        onBackToLive={onBackToLive}
        backToLiveLabel="POS thật →"
        summary="Mô phỏng đầy đủ màn hình Điểm thu & Sổ cái ca trực · chưa kết nối API/RPC thật"
      />

      <div className="pos-live-workspace">
        {/* Cột trái: Phát hành hóa đơn & QR (khớp InvoiceForm.tsx) */}
        <section
          className="surface-panel invoice-form-panel"
          aria-labelledby="demo-invoice-form-title"
          aria-busy={uiState === "loading"}
        >
          <div className="panel-top-row">
            <div>
              <span className="panel-eyebrow">
                01 · PHÁT HÀNH HÓA ĐƠN · MINH HỌA
              </span>
              <h2 id="demo-invoice-form-title" className="screen-title">
                Tạo hóa đơn POS
              </h2>
              <p className="screen-subtitle">
                {invoice.meta.merchantName} · {invoice.meta.serviceName} · giá
                gốc 3 CAMPUS (SBT 2,7 CAMPUS)
              </p>
            </div>
            <span
              className={`network-pill ${isWrongChain ? "pill-danger" : "pill-ok"}`}
            >
              <span className="status-dot" aria-hidden="true" />
              {isWrongChain
                ? "Mẫu lỗi · Sai mạng"
                : `${campusNetwork.name} · Chain ${campusNetwork.chainId} (Mẫu)`}
            </span>
          </div>

          <div className="invoice-form-actions">
            <div className="invoice-form-copy">
              <p>
                Backend ấn định giá và ký hóa đơn. Sinh viên xác nhận thanh toán
                bằng ví Core (dữ liệu mẫu).
              </p>
              <div className="pos-autorenew-row">
                <button
                  type="button"
                  className={`pos-autorenew-toggle ${autoRenewDemo ? "is-on" : ""}`}
                  aria-pressed={autoRenewDemo}
                  onClick={() => {
                    setAutoRenewDemo((prev) => {
                      const next = !prev;
                      if (!next) setDemoCountdown(null);
                      return next;
                    });
                  }}
                >
                  <span className="autorenew-dot" aria-hidden="true" />
                  Tự làm mới QR khi thu xong:{" "}
                  <strong>{autoRenewDemo ? "Đang bật" : "Đang tắt"}</strong>
                </button>
              </div>
            </div>
            <button
              type="button"
              className="primary-cta-btn"
              onClick={() => issueNextDemoInvoice(uiState === "receipt")}
            >
              <Icon name="qr" />
              Tạo hóa đơn mẫu mới
            </button>
          </div>

          <div className="invoice-form-result">
            {uiState === "receipt" ? (
              <div className="pos-gate-pass" role="status">
                <div className="gate-pass-main">
                  <span className="gate-pass-icon">
                    <Icon name="check" />
                  </span>
                  <div>
                    <span className="verified-badge">
                      BIÊN LAI MẪU · CHO QUA CỔNG (CHƯA XÁC MINH ON-CHAIN)
                    </span>
                    <h3>Thực thu {formatCampusWei(activePaidWei)}</h3>
                    <p>
                      {activeTier === 1
                        ? "Đã áp dụng ưu đãi thẻ sinh viên SBT (-10%)"
                        : "Thu theo mức giá tiêu chuẩn"}{" "}
                      · Block #{baseReceipt.blockNumber} (Mẫu)
                    </p>
                    {demoCountdown !== null ? (
                      <p className="pos-autorenew-countdown">
                        Tự động tạo mã QR mẫu mới cho xe tiếp theo sau{" "}
                        <strong>{demoCountdown}s</strong>…
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="gate-pass-actions">
                  <button
                    type="button"
                    className="primary-cta-btn"
                    onClick={() => issueNextDemoInvoice(true)}
                  >
                    <Icon name="qr" />
                    {demoCountdown !== null
                      ? "Làm mới QR mẫu ngay"
                      : "Tạo lượt thu tiếp theo"}
                  </button>
                  {demoCountdown !== null ? (
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => {
                        setHoldAutoRenew(true);
                        setDemoCountdown(null);
                      }}
                    >
                      Giữ biên lai mẫu
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {uiState !== "receipt" &&
            demoLastPaid &&
            demoLastPaid.invoiceId.toLowerCase() !==
              activeEntry.invoiceId.toLowerCase() ? (
              <div className="pos-last-paid-banner" role="status">
                <div className="last-paid-copy">
                  <span className="last-paid-check" aria-hidden="true">
                    <Icon name="check" />
                  </span>
                  <div>
                    <strong>
                      Lượt mẫu vừa thu xong ({demoLastPaid.code}): Đã nhận{" "}
                      {formatCampusWei(demoLastPaid.paidAmountWei)} · Cho xe qua
                      cổng
                    </strong>
                    <p>
                      Mã QR mẫu bên dưới đã tự động làm mới (
                      {activeEntry.invoiceCode}) — sẵn sàng cho xe tiếp theo
                      quét.
                    </p>
                  </div>
                </div>
                <div className="last-paid-actions">
                  <button
                    type="button"
                    className="secondary-btn btn-compact"
                    onClick={() => selectHistoryInvoice(demoLastPaid.invoiceId)}
                  >
                    Xem lại biên lai
                  </button>
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

            {uiState === "loading" ? (
              <div className="invoice-form-loading" aria-live="polite" aria-busy="true">
                <div className="status-banner banner-loading">
                  <span className="spinner" aria-hidden="true" />
                  <div>
                    <strong>Đang tải dữ liệu hóa đơn mẫu…</strong>
                    <p>
                      Dữ liệu đang được tải trong tình huống mô phỏng. Chọn
                      “Hóa đơn” để quay lại bản xem trước.
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
            ) : (
              <>
                <div
                  className={`invoice-qr-card ${uiState === "receipt" ? "qr-card-paid" : ""}`}
                >
                  {uiState === "receipt" ? (
                    <span className="verified-badge">
                      ĐÃ THU TIỀN MẪU · HÓA ĐƠN HOÀN TẤT
                    </span>
                  ) : null}
                  <div className="qr-image-wrap demo-qr-wrap">
                    {qrImage ? (
                      <img
                        src={qrImage.src}
                        alt={`Mã QR mẫu cho hóa đơn ${activeEntry.invoiceCode}`}
                        width={qrImage.displayWidth}
                        height={qrImage.displayWidth}
                        style={{ maxWidth: qrImage.displayWidth }}
                      />
                    ) : (
                      <div
                        className="qr-placeholder"
                        role="img"
                        aria-label="Vùng QR mẫu, đang khởi tạo"
                      >
                        <span aria-hidden="true">QR</span>
                        <strong>Đang tạo mã QR mẫu…</strong>
                      </div>
                    )}
                    {uiState === "receipt" ? (
                      <div className="qr-paid-overlay" aria-hidden="true">
                        <span className="qr-paid-check">
                          <Icon name="check" />
                        </span>
                        <strong>ĐÃ THU XONG (MẪU)</strong>
                        <small>
                          {demoCountdown !== null
                            ? `Đổi QR sau ${demoCountdown}s`
                            : "Không quét lại mã cũ"}
                        </small>
                      </div>
                    ) : null}
                  </div>
                  {uiState !== "receipt" ? (
                    <div className="pos-ttl-track" aria-hidden="true">
                      <div
                        className={`pos-ttl-fill ${
                          uiState === "error" && errorKind === "expired"
                            ? "ttl-danger"
                            : ""
                        }`}
                        style={{ width: `${ttlBarPct}%` }}
                      />
                    </div>
                  ) : null}
                  <span className="metric-note">
                    {uiState === "receipt"
                      ? demoCountdown !== null
                        ? `Đang tự động cấp mã QR mẫu mới sau ${demoCountdown} giây…`
                        : "Mã QR cũ đã làm mờ để tránh quét nhầm. Bấm Tạo lượt thu tiếp theo ở trên."
                      : "Dùng nút Sao chép payload QR mẫu để thử dán sang trang Sinh viên."}
                  </span>
                </div>

                <div className="invoice-preview-data">
                  <h2>{invoice.meta.serviceName}</h2>
                  <p>Nơi thu: {invoice.meta.merchantName}</p>
                  <dl className="price-breakdown tabular-nums">
                    <div className="price-row">
                      <dt>Giá gốc</dt>
                      <dd className="tabular-nums">
                        {formatCampusWei(activeEntry.amountWei)}
                      </dd>
                    </div>
                    <div className="price-row discount-row">
                      <dt>Ưu đãi thẻ SBT (-10%)</dt>
                      <dd className="tabular-nums">
                        {formatCampusWei(sbtQuote.paidAmountWei)}
                      </dd>
                    </div>
                    <div className="price-row">
                      <dt>Mã hóa đơn</dt>
                      <dd>
                        <code className="mono-badge">
                          {activeEntry.invoiceCode}
                        </code>
                      </dd>
                    </div>
                    <div className="price-row">
                      <dt>Còn hiệu lực (mẫu)</dt>
                      <dd className="tabular-value">
                        {uiState === "receipt"
                          ? "Đã thanh toán (mẫu)"
                          : uiState === "error" && errorKind === "expired"
                            ? "Đã hết thời gian mẫu"
                            : "05:00 · Mốc mẫu"}
                      </dd>
                    </div>
                    <div className="price-row">
                      <dt>Người nhận</dt>
                      <dd>
                        <HashChip
                          value={invoice.invoice.merchant}
                          copyLabel="Sao chép địa chỉ merchant mẫu"
                        />
                      </dd>
                    </div>
                  </dl>
                  <p>
                    Khi tích hợp thật, trạng thái thanh toán và hết hạn được xác
                    minh qua API; biên lai mẫu không dùng để cho xe qua cổng.
                  </p>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className={`secondary-btn ${copiedPayload ? "is-copied-btn" : ""}`}
                      onClick={() => void copyPayload()}
                    >
                      <Icon name={copiedPayload ? "check" : "copy"} />
                      {copiedPayload
                        ? "Đã chép payload"
                        : "Sao chép payload QR mẫu"}
                    </button>
                  </div>
                  <details className="payload-panel">
                    <summary>
                      Payload để dán thủ công khi camera không dùng được
                    </summary>
                    <label
                      className="invoice-payload-label"
                      htmlFor="demo-invoice-payload"
                    >
                      Payload JSON mẫu đã ký
                    </label>
                    <textarea
                      id="demo-invoice-payload"
                      className="invoice-payload"
                      readOnly
                      value={activeQrPayload}
                      rows={4}
                    />
                  </details>
                </div>
              </>
            )}
          </div>
        </section>

        {/* Cột phải trên: Theo dõi trạng thái & Biên nhận (khớp InvoiceStatus.tsx + Receipt.tsx) */}
        <section
          className="surface-panel pos-status-panel"
          aria-labelledby="demo-pos-payment-status"
          aria-live="polite"
        >
          <div className="panel-heading-with-icon">
            <span className="panel-icon">
              <Icon name={uiState === "receipt" ? "check" : "clock"} />
            </span>
            <span className="panel-eyebrow">02 · THEO DÕI THANH TOÁN</span>
          </div>
          <h2 id="demo-pos-payment-status">{statusHeading[uiState]}</h2>

          {uiState === "loading" ||
          uiState === "awaiting-signature" ||
          uiState === "pending" ? (
            <div className="l1-shimmer-track" aria-hidden="true">
              <div className="l1-shimmer-bar" />
            </div>
          ) : null}

          <p role="status">
            {uiState === "waiting"
              ? "Đang chờ sinh viên quét mã QR và ký giao dịch trên ví Core (tình huống mô phỏng)."
              : uiState === "awaiting-signature"
                ? "Sinh viên đang kiểm tra số tiền và xác nhận ký trong ví Core."
                : uiState === "pending"
                  ? "Đã nhận hash giao dịch mẫu, đang chờ receipt và sự kiện khớp hóa đơn."
                  : uiState === "receipt"
                    ? "Đã đối chiếu biên lai mẫu thành công. Có thể cấp mã QR cho lượt tiếp theo."
                    : uiState === "loading"
                      ? "Đang đồng bộ hóa đơn mẫu từ bộ nhớ minh họa…"
                      : "Không xác nhận đã thu tiền khi giao dịch gặp lỗi hoặc chưa có receipt."}
          </p>

          <div className="status-id-row">
            <span className="status-id-label">invoiceId</span>
            <HashChip
              value={activeEntry.invoiceId}
              start={8}
              end={6}
              copyLabel="Sao chép invoiceId mẫu"
            />
          </div>

          {uiState === "pending" ||
          (uiState === "error" && errorKind === "rpc-unreachable") ? (
            <div className="status-id-row">
              <span className="status-id-label">TxHash</span>
              <HashChip
                value={activeTxHash}
                start={10}
                end={8}
                copyLabel="Sao chép mã giao dịch mẫu"
              />
            </div>
          ) : null}

          {uiState === "error" ? (
            <div className="error-panel" role="alert">
              <div className="error-header">
                <span className="error-code-badge">
                  TÌNH HUỐNG MẪU · {activeError.code}
                </span>
              </div>
              <p className="error-body">{activeError.posMessage}</p>
              <div className="next-step-box">
                <strong>Hướng xử lý tại điểm thu:</strong>
                <p>{activeError.nextStepPos}</p>
              </div>
              <div className="inline-actions">
                <button
                  type="button"
                  className="primary-cta-btn"
                  onClick={() => {
                    setHoldAutoRenew(false);
                    setUiState("waiting");
                  }}
                >
                  {activeError.actionLabelPos}
                </button>
              </div>
            </div>
          ) : null}

          {uiState === "receipt" ? (
            <div className="invoice-verified-preview receipt-ticket">
              <div className="receipt-hero">
                <div className="receipt-hero-top">
                  <span className="receipt-hero-icon" aria-hidden="true">
                    <Icon name="check" />
                  </span>
                  <span className="verified-badge">
                    BIÊN NHẬN MẪU · CHƯA XÁC MINH ON-CHAIN
                  </span>
                </div>
                <span className="receipt-hero-label">Số tiền đã thanh toán (mẫu)</span>
                <strong className="receipt-hero-amount tabular-nums">
                  {formatCampusWei(activePaidWei)}
                </strong>
                {BigInt(activeDiscountWei) > BigInt(0) ? (
                  <div className="receipt-hero-savings tabular-nums">
                    <s className="receipt-original-strike">
                      {formatCampusWei(activeEntry.amountWei)}
                    </s>
                    <span className="receipt-savings-pill">
                      Tiết kiệm {formatCampusWei(activeDiscountWei)}
                      {activeTier === 1 ? " (-10% SBT)" : ""}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="receipt-tear-line" aria-hidden="true" />

              <dl className="price-breakdown tabular-nums">
                <div className="price-row invoice-code-row">
                  <dt>Mã hóa đơn</dt>
                  <dd>
                    <code className="mono-badge invoice-code-badge">{activeEntry.invoiceCode}</code>
                  </dd>
                </div>
                <div className="price-row">
                  <dt>Giá gốc</dt>
                  <dd>{formatCampusWei(activeEntry.amountWei)}</dd>
                </div>
                <div className="price-row discount-row">
                  <dt>Ưu đãi (tier {activeTier})</dt>
                  <dd>
                    {activeTier === 1
                      ? `-${formatCampusWei(activeDiscountWei)}`
                      : "0 CAMPUS"}
                  </dd>
                </div>
                <div className="price-row total-row">
                  <dt>Đã trả (mẫu)</dt>
                  <dd className="total-amount">
                    {formatCampusWei(activePaidWei)}
                  </dd>
                </div>
                <div className="price-row gas-row">
                  <dt>Gas (riêng)</dt>
                  <dd>{formatCampusWei(baseReceipt.gasFeeWei)}</dd>
                </div>
              </dl>

              <details className="receipt-proof-details">
                <summary>
                  Xem bằng chứng mẫu (Block #{baseReceipt.blockNumber})
                </summary>
                <div className="receipt-proof-body">
                  <p>Block / log</p>
                  <code className="tx-hash-code">
                    #{baseReceipt.blockNumber} / 0 (Mẫu)
                  </code>
                  <p>Người trả</p>
                  <code className="tx-hash-code">{activePayer}</code>
                  <p>Người nhận</p>
                  <code className="tx-hash-code">{invoice.invoice.merchant}</code>
                  <p>Hợp đồng · chain {campusNetwork.chainId}</p>
                  <code className="tx-hash-code">
                    {invoice.domain.verifyingContract}
                  </code>
                  <p>Tx hash mẫu</p>
                  <code className="tx-hash-code">{activeTxHash}</code>
                  <CopyButton
                    key={activeTxHash}
                    label="Sao chép tx hash mẫu"
                    value={activeTxHash}
                  />
                </div>
              </details>
            </div>
          ) : null}

          {uiState !== "error" && uiState !== "receipt" ? (
            <div className="inline-actions">
              {uiState === "waiting" ? (
                <>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setUiState("awaiting-signature")}
                  >
                    Mô phỏng chờ ký ví
                  </button>
                  <button
                    type="button"
                    className="primary-cta-btn"
                    onClick={() => {
                      setHoldAutoRenew(false);
                      setUiState("receipt");
                    }}
                  >
                    Mô phỏng đã thu tiền
                  </button>
                </>
              ) : null}
              {uiState === "awaiting-signature" ? (
                <>
                  <button
                    type="button"
                    className="primary-cta-btn"
                    onClick={() => setUiState("pending")}
                  >
                    Mô phỏng đang chờ xác nhận
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => {
                      setErrorKind("wallet-rejected");
                      setUiState("error");
                    }}
                  >
                    Thử lỗi từ chối ký
                  </button>
                </>
              ) : null}
              {uiState === "pending" ? (
                <>
                  <button
                    type="button"
                    className="primary-cta-btn"
                    onClick={() => {
                      setHoldAutoRenew(false);
                      setUiState("receipt");
                    }}
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
          ) : null}

          <details className="module-accordion" style={{ marginTop: "0.65rem" }}>
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
              </dl>
            </div>
          </details>
        </section>

        {/* Cột phải dưới: Mở lại / đối chiếu hóa đơn (khớp InvoiceForm.tsx) */}
        <form
          className="surface-panel invoice-recovery"
          onSubmit={handleRecoverySubmit}
          aria-labelledby="demo-invoice-recovery-title"
        >
          <span className="panel-eyebrow">TRA CỨU & KHÔI PHỤC · MẪU</span>
          <h2 id="demo-invoice-recovery-title">Mở lại / đối chiếu hóa đơn</h2>
          <label htmlFor="pos-demo-invoice-id">invoiceId</label>
          <input
            id="pos-demo-invoice-id"
            required
            value={lookupId}
            onChange={(e) => {
              setLookupId(e.target.value);
              setLookupError(null);
            }}
            aria-invalid={Boolean(lookupError)}
            aria-describedby="pos-demo-lookup-help pos-demo-lookup-error"
            autoComplete="off"
            spellCheck={false}
          />
          <label htmlFor="pos-demo-tx-hash">Tx hash (nếu đã có)</label>
          <input
            id="pos-demo-tx-hash"
            value={lookupTxHash}
            onChange={(e) => {
              setLookupTxHash(e.target.value);
              setLookupError(null);
            }}
            aria-invalid={Boolean(lookupError)}
            aria-describedby="pos-demo-lookup-help pos-demo-lookup-error"
            autoComplete="off"
            spellCheck={false}
          />
          <p id="pos-demo-lookup-help">
            Tra cứu đối chiếu trong danh sách hóa đơn mẫu bên dưới. Không gọi
            API hoặc RPC thật.
          </p>
          <p id="pos-demo-lookup-error" role="alert">
            {lookupError}
          </p>
          <button className="secondary-btn" type="submit">
            Tra cứu hóa đơn mẫu
          </button>
        </form>

        {/* Hàng cuối toàn chiều rộng: Nhật ký ca trực mẫu (khớp PosShiftLedger) */}
        <PosShiftLedger
          entries={shiftHistory}
          activeInvoiceId={activeEntry.invoiceId}
          demoMode
          onSelectInvoice={selectHistoryInvoice}
        />
      </div>
    </>
  );
}
