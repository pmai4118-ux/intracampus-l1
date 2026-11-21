"use client";
import { CAMPUS_CHAIN_ID } from "@intracampus/network";


import Link from "next/link";
import { useState } from "react";
import Icon from "../components/Icon";
import PageHeading from "../components/PageHeading";
import { InvoiceForm } from "./InvoiceForm";
import PosDemo from "./PosDemo";

export default function PointOfSalePage() {
  const [mode, setMode] = useState<"live" | "demo">("live");
  return (
    <>
      <PageHeading
        eyebrow="KHÔNG GIAN ĐIỂM THU"
        title="Mỗi lượt thu, thật rõ ràng."
        description="Tạo QR vào bãi xe, theo dõi thanh toán và xác nhận lượt ra."
        icon="store"
      >
        <span className="page-context-tag">
          <Icon name="store" />
          Bãi xe campus
        </span>
        <Link className="secondary-btn" href="/staff/canteen">
          Quầy bếp nhà ăn →
        </Link>
        <Link className="secondary-btn" href="/staff/parking">
          Mở cổng ra →
        </Link>
      </PageHeading>
      <div className="workspace-toolbar">
        <p className="workspace-caption">
          Đơn giản cho điểm thu. Thuận tiện cho sinh viên.
        </p>
        <div className="mode-switch-wrapper">
          <span className="mode-switch-kicker">
            <span
              className={`mode-status-dot ${mode === "live" ? "dot-live" : "dot-demo"}`}
              aria-hidden="true"
            />
            {mode === "live" ? `Avalanche L1 · Chain ${CAMPUS_CHAIN_ID}` : "Bản minh họa"}
          </span>
          <div className="student-mode-switch" role="group" aria-label="Chế độ POS">
            <button
              type="button"
              className="secondary-btn"
              aria-pressed={mode === "live"}
              onClick={() => setMode("live")}
            >
              POS thật
            </button>
            <button
              type="button"
              className="secondary-btn"
              aria-pressed={mode === "demo"}
              onClick={() => setMode("demo")}
            >
              Xem bản minh họa
            </button>
          </div>
        </div>
      </div>
      {mode === "live" ? (
        <div className="pos-live-workspace">
          <InvoiceForm />
        </div>
      ) : (
        <PosDemo onBackToLive={() => setMode("live")} />
      )}
    </>
  );
}
