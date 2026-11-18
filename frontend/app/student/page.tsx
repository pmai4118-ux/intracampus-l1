"use client";
import { useState } from "react";
import Link from "next/link";
import StudentDemo from "./StudentDemo";
import { StudentWallet, WalletSession } from "./WalletPanel";

export default function StudentPage() {
  const [mode, setMode] = useState<"live" | "demo">("live");
  return <>
    <nav className="library-actions" aria-label="Chọn dịch vụ sinh viên">{mode === "live" && <><a className="secondary-btn" href="#payment-gate-title">Thanh toán QR</a><a className="secondary-btn" href="#grant-title">Học bổng FOOD</a></>}<Link href="/student/canteen" className="secondary-btn">Nhà ăn · đặt món</Link><Link href="/student/library" className="secondary-btn">Mở thư viện · mượn và trả sách</Link></nav>
    <div className="student-mode-switch" role="group" aria-label="Chế độ ví sinh viên">
      <button type="button" className="secondary-btn" aria-pressed={mode === "live"} onClick={() => setMode("live")}>Ví thật</button>
      <button type="button" className="secondary-btn" aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>Xem bản minh họa</button>
    </div>
    {mode === "live" ? <WalletSession><StudentWallet /></WalletSession> : <StudentDemo />}
  </>;
}
