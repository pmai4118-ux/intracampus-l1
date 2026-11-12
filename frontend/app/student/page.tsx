"use client";
import { useState } from "react";
import StudentDemo from "./StudentDemo";
import { StudentWallet, WalletSession } from "./WalletPanel";

export default function StudentPage() {
  const [mode, setMode] = useState<"live" | "demo">("live");
  return <>
    <div className="student-mode-switch" role="group" aria-label="Chế độ ví sinh viên">
      <button type="button" className="secondary-btn" aria-pressed={mode === "live"} onClick={() => setMode("live")}>Ví thật</button>
      <button type="button" className="secondary-btn" aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>Xem bản minh họa</button>
    </div>
    {mode === "live" ? <WalletSession><StudentWallet /></WalletSession> : <StudentDemo />}
  </>;
}
