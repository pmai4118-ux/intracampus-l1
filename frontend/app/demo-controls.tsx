"use client";

import { useState } from "react";
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
}: {
  state: DemoUiState;
  wallet: DemoWalletKind;
  error: DemoErrorKind;
  onState: (value: DemoUiState) => void;
  onWallet: (value: DemoWalletKind) => void;
  onError: (value: DemoErrorKind) => void;
}) {
  return (
    <aside className="demo-notice" aria-label="Chế độ xem thử">
      <strong>Bản xem thử · Dữ liệu mẫu</strong>
      <p>
        Chưa kết nối ví hoặc blockchain. Các thao tác và biên lai bên dưới chỉ
        để thử giao diện.
      </p>
      <details className="demo-toolbar">
        <summary>Thử các trạng thái màn hình</summary>
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
        className={className}
        disabled={status === "copying"}
        onClick={copy}
      >
        {status === "success"
          ? "Đã sao chép"
          : status === "copying"
            ? "Đang sao chép…"
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
