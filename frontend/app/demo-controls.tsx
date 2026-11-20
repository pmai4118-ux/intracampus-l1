"use client";

import { useEffect, useState } from "react";
import Icon from "./components/Icon";
import {
  demoErrorScenarios,
  type DemoErrorKind,
  type DemoUiState,
  type DemoWalletKind,
} from "./demo-fixtures";

export function DemoControls({
  state,
  wallet,
  error,
  onState,
  onWallet,
  onError,
  onBackToLive,
  backToLiveLabel = "Quay lại bản thật →",
  summary = "Mô phỏng giao diện · chưa kết nối ví thật",
}: {
  state: DemoUiState;
  wallet: DemoWalletKind;
  error: DemoErrorKind;
  onState: (value: DemoUiState) => void;
  onWallet: (value: DemoWalletKind) => void;
  onError: (value: DemoErrorKind) => void;
  onBackToLive?: () => void;
  backToLiveLabel?: string;
  summary?: string;
}) {
  return (
    <aside className="demo-notice demo-pill-banner" aria-label="Chế độ xem thử">
      <div className="demo-pill-head">
        <span className="demo-pill-badge">
          <span className="mode-status-dot dot-demo" aria-hidden="true" />
          Bản minh họa · Dữ liệu mẫu
        </span>
        <span className="demo-pill-summary">{summary}</span>
      </div>
      <div className="demo-pill-actions">
        <div
          className="segmented-row"
          role="group"
          aria-label="Chọn nhanh tài khoản mẫu"
        >
          {(
            [
              ["sbt", "Có SBT (-10%)"],
              ["standard", "Ví thường (0%)"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={wallet === value ? "seg-btn active" : "seg-btn"}
              aria-pressed={wallet === value}
              onClick={() => onWallet(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {onBackToLive ? (
          <button
            type="button"
            className="secondary-btn btn-pill-sm"
            onClick={onBackToLive}
          >
            {backToLiveLabel}
          </button>
        ) : null}
      </div>
      <details className="demo-toolbar">
        <summary>Thử các trạng thái màn hình</summary>
        <div className="demo-toolbar-body">
          <div className="demo-toolbar-row">
            <span className="demo-toolbar-label">Trạng thái</span>
            <div
              className="segmented-group"
              role="group"
              aria-label="Chọn trạng thái màn hình"
            >
              {(
                [
                  ["waiting", "Hóa đơn"],
                  ["loading", "Đang tải"],
                  ["awaiting-signature", "Chờ ký"],
                  ["pending", "Chờ xác nhận"],
                  ["error", "Lỗi"],
                  ["receipt", "Biên lai mẫu"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={state === value ? "seg-btn active" : "seg-btn"}
                  aria-pressed={state === value}
                  onClick={() => onState(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="demo-toolbar-row">
            <span className="demo-toolbar-label">Tài khoản mẫu</span>
            <div
              className="segmented-group"
              role="group"
              aria-label="Chọn tài khoản mẫu"
            >
              {(
                [
                  ["sbt", "Có thẻ · Giảm 10%"],
                  ["standard", "Không có thẻ · Giá gốc"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={wallet === value ? "seg-btn active" : "seg-btn"}
                  aria-pressed={wallet === value}
                  onClick={() => onWallet(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {state === "error" && (
            <div className="demo-toolbar-row">
              <span className="demo-toolbar-label">Tình huống lỗi</span>
              <div
                className="segmented-group"
                role="group"
                aria-label="Chọn tình huống lỗi"
              >
                {Object.values(demoErrorScenarios).map((scenario) => (
                  <button
                    key={scenario.kind}
                    type="button"
                    className={
                      error === scenario.kind ? "seg-btn active" : "seg-btn"
                    }
                    aria-pressed={error === scenario.kind}
                    onClick={() => onError(scenario.kind)}
                  >
                    {scenario.shortTabLabel}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </details>
    </aside>
  );
}

export function CopyButton({
  value,
  label,
  className = "secondary-btn",
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [status, setStatus] = useState<
    "idle" | "copying" | "success" | "error"
  >("idle");
  useEffect(() => {
    if (status !== "success") return;
    const timer = window.setTimeout(() => setStatus("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [status]);
  async function copy() {
    setStatus("copying");
    try {
      await navigator.clipboard.writeText(value);
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }
  return (
    <span className="copy-control">
      <button
        type="button"
        className={`${className} ${status === "success" ? "is-copied-btn" : ""}`}
        disabled={status === "copying"}
        onClick={copy}
      >
        <Icon name={status === "success" ? "check" : "copy"} />
        {status === "success"
          ? "Đã chép"
          : status === "copying"
            ? "Đang chép…"
            : label}
      </button>
      <span className="copy-feedback" role="status">
        {status === "error"
          ? "Không sao chép được. Hãy chọn và chép nội dung hiển thị bên dưới."
          : ""}
      </span>
    </span>
  );
}
