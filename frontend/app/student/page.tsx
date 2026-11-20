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
      <Link className="button-quiet" href="/student/library"><Icon name="book" />Ghé thư viện<Icon name="arrow" /></Link>
    </PageHeading>
    <div className="workspace-toolbar">
      <nav className="student-service-nav" aria-label="Chọn dịch vụ sinh viên"><a href="#payment-gate-title"><Icon name="qr" />Thanh toán QR</a>{mode === "live" ? <a href="#parking-tickets"><Icon name="store" />Vé gửi xe</a> : null}<a href="#grant-title"><Icon name="sparkle" />Học bổng FOOD</a><Link href="/student/canteen"><Icon name="utensils" />Nhà ăn · đặt món</Link></nav>
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
    </div>
    {mode === "live" ? <WalletSession><StudentWallet onOpenDemo={() => setMode("demo")} /></WalletSession> : <StudentDemo onBackToLive={() => setMode("live")} />}
  </>;
}
