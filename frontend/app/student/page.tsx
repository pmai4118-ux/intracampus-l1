"use client";
import { useState } from "react";
import Link from "next/link";
import StudentDemo from "./StudentDemo";
import { StudentWallet, WalletSession } from "./WalletPanel";
import PageHeading from "../components/PageHeading";
import Icon from "../components/Icon";

export default function StudentPage() {
  const [mode, setMode] = useState<"live" | "demo">("live");
  return <>
    <PageHeading eyebrow="KHÔNG GIAN SINH VIÊN" title="Campus trong tầm tay." description="Ví, ưu đãi và những tiện ích cho ngày đến trường của bạn." icon="graduation">
      <div className="student-heading-actions">
        <div className="mode-switch-wrapper">
          <span className="mode-switch-kicker">
            <span className={`mode-status-dot ${mode === "live" ? "dot-live" : "dot-demo"}`} aria-hidden="true" />
            {mode === "live" ? "Avalanche L1 · Chain 20261" : "Bản minh họa"}
          </span>
          <div className="student-mode-switch" role="group" aria-label="Chế độ ví sinh viên">
            <button type="button" className="secondary-btn" aria-pressed={mode === "live"} onClick={() => setMode("live")}>Ví thật</button>
            <button type="button" className="secondary-btn" aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>Xem bản minh họa</button>
          </div>
        </div>
        <div className="student-heading-links">
          <Link className="secondary-btn btn-compact" href="/student/canteen"><Icon name="utensils" />Nhà ăn</Link>
          <Link className="secondary-btn btn-compact" href="/student/library"><Icon name="book" />Thư viện</Link>
        </div>
      </div>
    </PageHeading>
    {mode === "live" ? <WalletSession><StudentWallet onOpenDemo={() => setMode("demo")} /></WalletSession> : <StudentDemo onBackToLive={() => setMode("live")} />}
  </>;
}
