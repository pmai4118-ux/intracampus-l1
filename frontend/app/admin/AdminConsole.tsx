"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  AdminAuditEntry,
  AdminOverview,
  AdminStudentRecord,
  AdminTxStatus,
  AdminWalletSlot,
} from "@intracampus/network";
import { formatWalletBalance } from "../../lib/chains";
import { AdminApiError, adminApi, parseCampusToWei } from "../../lib/admin-api";
import HashChip from "../components/HashChip";
import Icon from "../components/Icon";

type TabKey = "wallets" | "students" | "scholarships" | "audit";
type StudentFilter = "all" | "pending" | "approved" | "sbt" | "held";

function formatWeiSafe(wei: string | null | undefined): string {
  if (!wei) return "—";
  try {
    return formatWalletBalance(BigInt(wei));
  } catch {
    return wei;
  }
}

function formatUnix(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  const ms = seconds < 1e11 ? seconds * 1000 : seconds;
  return new Date(ms).toLocaleString("vi-VN");
}

function sbtExpiryFromDays(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 86_400;
}

function statusPillClass(status: string | null | undefined): string {
  if (status === "APPROVED" || status === "CONFIRMED" || status === "DONE") return "admin-pill admin-pill-ok";
  if (status === "PENDING" || status === "SUBMITTED") return "admin-pill admin-pill-warn";
  if (status === "REJECTED" || status === "FAILED") return "admin-pill admin-pill-danger";
  return "admin-pill";
}

export default function AdminConsole() {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    let active = true;
    void adminApi
      .session()
      .then((res) => {
        if (!active) return;
        setAuthenticated(res.authenticated);
      })
      .catch((err) => {
        if (!active) return;
        setAuthError(err instanceof Error ? err.message : "Không kết nối được tới máy chủ.");
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    if (!keyInput.trim() || authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    try {
      const res = await adminApi.login(keyInput.trim());
      setAuthenticated(res.authenticated);
      setKeyInput("");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Access key không hợp lệ.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await adminApi.logout();
    } finally {
      setAuthenticated(false);
    }
  }

  if (checking) {
    return (
      <div className="admin-gate-wrap">
        <section className="admin-gate-card" aria-busy="true">
          <div className="admin-gate-head">
            <span className="admin-gate-icon"><Icon name="shield" /></span>
            <div>
              <h1>Đang kiểm tra phiên</h1>
              <p>Vui lòng chờ trong giây lát…</p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="admin-gate-wrap">
        <section className="admin-gate-card" aria-labelledby="admin-gate-title">
          <div className="admin-gate-head">
            <span className="admin-gate-icon"><Icon name="shield" /></span>
            <div>
              <h1 id="admin-gate-title">Cổng quản trị nội bộ</h1>
              <p>Nhập Access Key của nhóm để mở khóa bảng điều khiển test.</p>
            </div>
          </div>
          <form className="admin-form" onSubmit={(e) => void handleLogin(e)}>
            <div className="admin-field">
              <label htmlFor="admin-access-key">Access Key</label>
              <div className="admin-key-input-row">
                <input
                  id="admin-access-key"
                  className="admin-input admin-input-mono"
                  type={showKey ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Nhập key cố định của nhóm…"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  disabled={authBusy}
                  autoFocus
                  required
                />
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setShowKey((prev) => !prev)}
                  disabled={authBusy}
                >
                  {showKey ? "Ẩn" : "Hiện"}
                </button>
              </div>
            </div>
            {authError ? <p className="admin-banner admin-banner-error" role="alert">{authError}</p> : null}
            <button type="submit" className="primary-cta-btn" disabled={authBusy || !keyInput.trim()}>
              {authBusy ? "Đang xác thực…" : "Mở khóa bảng điều khiển"}
            </button>
          </form>
        </section>
      </div>
    );
  }

  return <AdminDashboard onLock={() => void handleLogout()} />;
}

function AdminDashboard({ onLock }: { onLock: () => void }) {
  const [tab, setTab] = useState<TabKey>("wallets");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [students, setStudents] = useState<AdminStudentRecord[]>([]);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [trackedTx, setTrackedTx] = useState<AdminTxStatus | null>(null);

  // Wallet tab form states
  const [walletDrafts, setWalletDrafts] = useState({
    parking: "",
    canteen: "",
    libraryTreasury: "",
    libraryLibrarian: "",
  });
  const [revokeOldParking, setRevokeOldParking] = useState(false);
  const [revokeOldCanteen, setRevokeOldCanteen] = useState(false);
  const [welcomeTreasuryDraft, setWelcomeTreasuryDraft] = useState("");
  const [scholarshipDefaultDraft, setScholarshipDefaultDraft] = useState("");
  const [allowlistMerchant, setAllowlistMerchant] = useState("");
  const [allowlistCategory, setAllowlistCategory] = useState<"PARKING" | "FOOD">("PARKING");
  const [allowlistAllowed, setAllowlistAllowed] = useState(true);

  // Student inspector & filter states
  const [inspectInput, setInspectInput] = useState("");
  const [inspected, setInspected] = useState<AdminStudentRecord | null>(null);
  const [inspectCode, setInspectCode] = useState("");
  const [inspectProgram, setInspectProgram] = useState("");
  const [sbtDays, setSbtDays] = useState("180");
  const [fundAmount, setFundAmount] = useState("50");
  const [studentQuery, setStudentQuery] = useState("");
  const [studentFilter, setStudentFilter] = useState<StudentFilter>("all");

  // FOOD scholarship direct form
  const [grantWallet, setGrantWallet] = useState("");
  const [grantAmount, setGrantAmount] = useState("1000");
  const [grantMarkApproved, setGrantMarkApproved] = useState(true);

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [ov, st, au] = await Promise.all([
        adminApi.overview(),
        adminApi.listStudents(),
        adminApi.audit(60),
      ]);
      setOverview(ov);
      setStudents(st.students);
      setAudit(au.entries);
      setWelcomeTreasuryDraft((prev) => prev || ov.campusSettings.welcomeTreasury || "");
      setScholarshipDefaultDraft((prev) => {
        if (prev) return prev;
        try {
          const whole = BigInt(ov.campusSettings.scholarshipWei) / (BigInt(10) ** BigInt(18));
          return whole.toString();
        } catch {
          return "1000";
        }
      });
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        onLock();
        return;
      }
      setError(err instanceof Error ? err.message : "Không tải được dữ liệu quản trị.");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [onLock]);

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  // Poll active submitted transaction until confirmed/failed
  useEffect(() => {
    if (!trackedTx || trackedTx.status !== "SUBMITTED") return;
    let active = true;
    const poll = () => {
      void adminApi
        .txStatus(trackedTx.txHash)
        .then((next) => {
          if (!active) return;
          setTrackedTx(next);
          if (next.status !== "SUBMITTED") {
            void loadAll(true);
            if (inspected) {
              void adminApi.inspectStudent(inspected.wallet).then((r) => {
                if (active) setInspected(r.student);
              }).catch(() => undefined);
            }
          }
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(poll, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [trackedTx, loadAll, inspected]);

  async function runAction(key: string, work: () => Promise<void>) {
    setBusyKey(key);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        onLock();
        return;
      }
      setError(err instanceof Error ? err.message : "Thao tác thất bại.");
    } finally {
      setBusyKey(null);
    }
  }

  function trackHash(txHash: string | null | undefined, successMsg: string) {
    if (txHash) {
      setTrackedTx({ txHash, status: "SUBMITTED", blockNumber: null, blockHash: null });
    }
    setNotice(successMsg);
  }

  async function refreshInspectedIfMatching(wallet: string) {
    if (inspected && inspected.wallet.toLowerCase() === wallet.toLowerCase()) {
      const res = await adminApi.inspectStudent(wallet);
      setInspected(res.student);
    }
  }

  async function handleWalletUpdate(slot: AdminWalletSlot) {
    const draft = walletDrafts[slot.id].trim();
    if (!draft) return;
    await runAction(`wallet:${slot.id}`, async () => {
      if (slot.id === "parking") {
        const res = await adminApi.updateMerchant({ kind: "PARKING", address: draft, revokePrevious: revokeOldParking });
        trackHash(res.txHashes.at(-1), `Đã cập nhật ví Bãi xe sang ${res.address}.`);
      } else if (slot.id === "canteen") {
        const res = await adminApi.updateMerchant({ kind: "FOOD", address: draft, revokePrevious: revokeOldCanteen });
        trackHash(res.txHashes.at(-1), `Đã cập nhật ví Nhà ăn sang ${res.address}.`);
      } else if (slot.id === "libraryTreasury") {
        const res = await adminApi.updateLibraryTreasury(draft);
        trackHash(res.txHash, `Đã gửi giao dịch đổi ví Treasury Thư viện sang ${res.address}.`);
      } else {
        const res = await adminApi.updateLibraryLibrarian(draft);
        trackHash(res.txHash, `Đã gửi giao dịch đổi ví Thủ thư sang ${res.address} và cập nhật quyền đăng nhập.`);
      }
      setWalletDrafts((prev) => ({ ...prev, [slot.id]: "" }));
      await loadAll(true);
    });
  }

  async function handleInspect(walletOverride?: string) {
    const target = (walletOverride ?? inspectInput).trim();
    if (!target) return;
    await runAction("inspect", async () => {
      const res = await adminApi.inspectStudent(target);
      setInspected(res.student);
      setInspectInput(res.student.wallet);
      setInspectCode(res.student.application?.studentCode ?? "");
      setInspectProgram(res.student.application?.program ?? "");
    });
  }

  async function handleApproveStudent(wallet: string, approve: boolean, code?: string, program?: string) {
    await runAction(`review-student:${wallet}`, async () => {
      const res = await adminApi.reviewStudent({
        wallet,
        approve,
        studentCode: code?.trim() || undefined,
        program: program?.trim() || undefined,
        autoEnrollLibrary: approve,
      });
      setNotice(approve ? `Đã duyệt sinh viên & mở dịch vụ cho ${res.student.wallet}.` : `Đã từ chối hồ sơ ${res.student.wallet}.`);
      if (inspected && inspected.wallet.toLowerCase() === wallet.toLowerCase()) setInspected(res.student);
      await loadAll(true);
    });
  }

  async function handleToggleAccess(wallet: string, enabled?: boolean, releaseHolds?: boolean) {
    await runAction(`access:${wallet}`, async () => {
      const res = await adminApi.updateStudentAccess(wallet, { enabled, releaseHolds });
      setNotice(res.audit.summary);
      if (inspected && inspected.wallet.toLowerCase() === wallet.toLowerCase()) setInspected(res.student);
      await loadAll(true);
    });
  }

  async function handleMintSbt(wallet: string, replaceExisting: boolean) {
    const days = Number(sbtDays);
    if (!Number.isFinite(days) || days < 1) {
      setError("Số ngày hiệu lực SBT phải lớn hơn hoặc bằng 1.");
      return;
    }
    await runAction(`mint-sbt:${wallet}`, async () => {
      const res = await adminApi.mintSbt(wallet, { expiresAt: sbtExpiryFromDays(Math.round(days)), replaceExisting });
      trackHash(res.txHashes.at(-1), `Đã gửi giao dịch cấp SBT (${Math.round(days)} ngày) cho ${res.wallet}.`);
      await loadAll(true);
      await refreshInspectedIfMatching(wallet);
    });
  }

  async function handleRevokeSbt(wallet: string) {
    await runAction(`revoke-sbt:${wallet}`, async () => {
      const res = await adminApi.revokeSbt(wallet);
      trackHash(res.txHash, `Đã gửi giao dịch thu hồi SBT #${res.tokenId} của ${res.wallet}.`);
      await loadAll(true);
      await refreshInspectedIfMatching(wallet);
    });
  }

  async function handleFundCampus(wallet: string, amountText: string) {
    let amountWei: string;
    try {
      amountWei = parseCampusToWei(amountText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Số CAMPUS không hợp lệ.");
      return;
    }
    await runAction(`fund:${wallet}`, async () => {
      const res = await adminApi.fundCampus(wallet, amountWei);
      trackHash(res.txHash, `Đã gửi ${formatWeiSafe(res.amountWei)} tới ${res.wallet}.`);
      await loadAll(true);
      await refreshInspectedIfMatching(wallet);
    });
  }

  async function handleReviewScholarship(wallet: string, approve: boolean, autoApproveStudent = false) {
    await runAction(`review-sch:${wallet}`, async () => {
      const res = await adminApi.reviewScholarship({ wallet, approve, category: "SUPPORT", autoApproveStudent });
      setNotice(approve ? `Đã duyệt hồ sơ học bổng FOOD cho ${wallet}.` : `Đã từ chối hồ sơ học bổng cho ${wallet}.`);
      if (inspected && inspected.wallet.toLowerCase() === wallet.toLowerCase()) setInspected(res.student);
      await loadAll(true);
    });
  }

  async function handleIssueFoodGrant(wallet: string, amountText: string, markApproved = true) {
    let amountWei: string;
    try {
      amountWei = parseCampusToWei(amountText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Số CAMPUS học bổng không hợp lệ.");
      return;
    }
    await runAction(`grant:${wallet}`, async () => {
      const res = await adminApi.issueFoodGrant({ wallet, amountWei, markScholarshipApproved: markApproved });
      trackHash(res.txHash, `Đã giải ngân học bổng FOOD ${formatWeiSafe(res.amountWei)} cho ${res.wallet}.`);
      await loadAll(true);
      await refreshInspectedIfMatching(wallet);
    });
  }

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    return students.filter((item) => {
      if (studentFilter === "pending" && item.application?.status !== "PENDING") return false;
      if (studentFilter === "approved" && item.application?.status !== "APPROVED") return false;
      if (studentFilter === "sbt" && item.onChain.sbtTier !== 1) return false;
      if (studentFilter === "held" && !item.libraryAccount?.held) return false;
      if (!q) return true;
      return (
        item.wallet.toLowerCase().includes(q) ||
        (item.application?.studentCode.toLowerCase().includes(q) ?? false) ||
        (item.application?.program.toLowerCase().includes(q) ?? false)
      );
    });
  }, [students, studentQuery, studentFilter]);

  const scholarshipList = useMemo(
    () => students.filter((item) => item.scholarship !== null || BigInt(item.onChain.foodGrantBalanceWei ?? "0") > BigInt(0)),
    [students],
  );

  const configuredSignersCount = overview?.signers.filter((s) => s.configured).length ?? 0;

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="admin-brand-group">
          <span className="admin-brand-badge"><Icon name="shield" /></span>
          <div>
            <h1>IntraCampus · Bảng quản trị test nội bộ</h1>
            <p className="admin-brand-sub">
              <span>{overview ? `${overview.networkName} · Chain ${overview.chainId}` : "Đang tải cấu hình mạng…"}</span>
              {overview?.blockNumber !== null && overview?.blockNumber !== undefined ? (
                <span className="admin-pill admin-pill-ok">Block #{overview.blockNumber}</span>
              ) : (
                <span className="admin-pill admin-pill-warn">Chưa đọc được block</span>
              )}
              {overview?.deploymentStatus === "deployed" ? (
                <span className="admin-pill admin-pill-ok">Manifest đã triển khai</span>
              ) : (
                <span className="admin-pill admin-pill-warn">Manifest chưa triển khai</span>
              )}
            </p>
          </div>
        </div>
        <div className="admin-topbar-actions">
          <button type="button" className="secondary-btn" disabled={loading || busyKey !== null} onClick={() => void loadAll(false)}>
            {loading ? "Đang tải…" : "Làm mới dữ liệu"}
          </button>
          <button type="button" className="admin-danger-btn" onClick={onLock}>
            Khóa phiên
          </button>
        </div>
      </header>

      {error ? (
        <div className="admin-banner admin-banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="secondary-btn" onClick={() => setError("")}>Đóng</button>
        </div>
      ) : null}

      {notice ? (
        <div className="admin-banner admin-banner-ok" role="status">
          <span>{notice}</span>
          <button type="button" className="secondary-btn" onClick={() => setNotice("")}>Đóng</button>
        </div>
      ) : null}

      {trackedTx ? (
        <div
          className={`admin-banner ${
            trackedTx.status === "CONFIRMED"
              ? "admin-banner-ok"
              : trackedTx.status === "FAILED"
                ? "admin-banner-error"
                : "admin-banner-pending"
          }`}
          role="status"
        >
          <div className="admin-inline-row">
            <strong>
              {trackedTx.status === "SUBMITTED"
                ? "Đang chờ xác nhận giao dịch trên L1…"
                : trackedTx.status === "CONFIRMED"
                  ? `Giao dịch đã xác nhận (Block #${trackedTx.blockNumber ?? "—"})`
                  : "Giao dịch bị revert trên chain"}
            </strong>
            <HashChip value={trackedTx.txHash} start={10} end={8} copyLabel="Sao chép mã giao dịch" />
          </div>
          <button type="button" className="secondary-btn" onClick={() => setTrackedTx(null)}>Ẩn</button>
        </div>
      ) : null}

      {overview ? (
        <section className="admin-kpi-grid" aria-label="Tổng quan nhanh">
          <button type="button" className="admin-kpi-card" onClick={() => setTab("wallets")}>
            <span className="admin-kpi-label">Ví đích dịch vụ</span>
            <strong className="admin-kpi-value">4 kênh</strong>
            <span className="admin-kpi-note">Bãi xe · Nhà ăn · Treasury · Thủ thư</span>
          </button>
          <button type="button" className="admin-kpi-card" onClick={() => setTab("students")}>
            <span className="admin-kpi-label">Hồ sơ sinh viên</span>
            <strong className="admin-kpi-value">{overview.counts.applicationsApproved} / {overview.counts.applicationsTotal}</strong>
            <span className="admin-kpi-note">{overview.counts.applicationsPending} chờ duyệt · {overview.counts.heldAccounts} đang hold</span>
          </button>
          <button type="button" className="admin-kpi-card" onClick={() => setTab("scholarships")}>
            <span className="admin-kpi-label">Học bổng FOOD</span>
            <strong className="admin-kpi-value">{overview.counts.scholarshipsApproved} đã duyệt</strong>
            <span className="admin-kpi-note">{overview.counts.scholarshipsPending} đơn đang chờ</span>
          </button>
          <button type="button" className="admin-kpi-card" onClick={() => setTab("audit")}>
            <span className="admin-kpi-label">VM Signers sẵn sàng</span>
            <strong className="admin-kpi-value">{configuredSignersCount} / {overview.signers.length}</strong>
            <span className="admin-kpi-note">Ký on-chain tự động từ GCP VM</span>
          </button>
        </section>
      ) : null}

      <nav className="admin-tabs" role="tablist" aria-label="Phân khu quản trị">
        {([
          ["wallets", "Ví đích dịch vụ", "wallet"],
          ["students", "Tư cách sinh viên & SBT", "graduation"],
          ["scholarships", "Học bổng FOOD", "sparkle"],
          ["audit", "Signers VM & Nhật ký", "clock"],
        ] as const).map(([key, label, icon]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`admin-tab-btn ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            <Icon name={icon} width={18} height={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {tab === "wallets" && overview ? (
        <section className="admin-form" aria-label="Tùy chỉnh ví đích">
          <div className="admin-grid-2">
            {(["parking", "canteen", "libraryTreasury", "libraryLibrarian"] as const).map((slotKey) => {
              const slot = overview.wallets[slotKey];
              const isMerchant = slot.id === "parking" || slot.id === "canteen";
              return (
                <article className="admin-card" key={slot.id}>
                  <div className="admin-card-head">
                    <div>
                      <h2>{slot.label}</h2>
                      <p className="admin-card-desc">{slot.description}</p>
                    </div>
                    <div className="admin-inline-row">
                      {slot.overridden ? <span className="admin-pill admin-pill-warn">Đã tùy chỉnh</span> : <span className="admin-pill">Mặc định</span>}
                      {slot.allowedOnChain === true ? <span className="admin-pill admin-pill-ok">Allowlist ON</span> : null}
                      {slot.allowedOnChain === false ? <span className="admin-pill admin-pill-danger">Chưa allowlist</span> : null}
                    </div>
                  </div>

                  <dl className="admin-kv">
                    <div className="admin-kv-row">
                      <dt>Ví đang hoạt động</dt>
                      <dd>{slot.address ? <HashChip value={slot.address} start={10} end={8} copyLabel={`Sao chép ${slot.label}`} /> : "Chưa cấu hình"}</dd>
                    </div>
                    <div className="admin-kv-row">
                      <dt>Số dư CAMPUS</dt>
                      <dd>{formatWeiSafe(slot.balanceWei)}</dd>
                    </div>
                    {slot.manifestAddress && slot.manifestAddress.toLowerCase() !== slot.address?.toLowerCase() ? (
                      <div className="admin-kv-row">
                        <dt>Mặc định manifest</dt>
                        <dd><HashChip value={slot.manifestAddress} start={8} end={6} copyLabel="Sao chép địa chỉ manifest" /></dd>
                      </div>
                    ) : null}
                  </dl>

                  {slot.mutableReason ? (
                    <p className="admin-banner admin-banner-pending">{slot.mutableReason}</p>
                  ) : null}

                  <form
                    className="admin-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleWalletUpdate(slot);
                    }}
                  >
                    <div className="admin-field">
                      <label htmlFor={`wallet-draft-${slot.id}`}>Đổi sang ví đích mới (0x...)</label>
                      <input
                        id={`wallet-draft-${slot.id}`}
                        className="admin-input admin-input-mono"
                        placeholder="0x..."
                        value={walletDrafts[slot.id]}
                        onChange={(e) => setWalletDrafts((prev) => ({ ...prev, [slot.id]: e.target.value }))}
                        disabled={!slot.mutableOnChain || busyKey !== null}
                      />
                    </div>
                    {isMerchant ? (
                      <label className="admin-checkbox">
                        <input
                          type="checkbox"
                          checked={slot.id === "parking" ? revokeOldParking : revokeOldCanteen}
                          onChange={(e) =>
                            slot.id === "parking"
                              ? setRevokeOldParking(e.target.checked)
                              : setRevokeOldCanteen(e.target.checked)
                          }
                        />
                        Thu hồi quyền nhận của ví cũ trên CampusPaymentRegistry
                      </label>
                    ) : null}
                    <div className="admin-inline-row">
                      <button
                        type="submit"
                        className="primary-cta-btn"
                        disabled={!slot.mutableOnChain || !walletDrafts[slot.id].trim() || busyKey !== null}
                      >
                        {busyKey === `wallet:${slot.id}` ? "Đang cập nhật…" : "Cập nhật ví đích"}
                      </button>
                      {slot.overridden && slot.manifestAddress ? (
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={!slot.mutableOnChain || busyKey !== null}
                          onClick={() => setWalletDrafts((prev) => ({ ...prev, [slot.id]: slot.manifestAddress ?? "" }))}
                        >
                          Điền lại mặc định
                        </button>
                      ) : null}
                    </div>
                  </form>
                </article>
              );
            })}
          </div>

          <div className="admin-grid-2">
            <article className="admin-card">
              <div className="admin-card-head">
                <div>
                  <h3>Tham số Campus Onboarding (Override test)</h3>
                  <p className="admin-card-desc">Tùy chỉnh ví quỹ chào mừng 20 CAMPUS và mức học bổng FOOD mặc định.</p>
                </div>
              </div>
              <form
                className="admin-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runAction("campus-settings", async () => {
                    const scholarshipWei = scholarshipDefaultDraft.trim() ? parseCampusToWei(scholarshipDefaultDraft) : null;
                    const res = await adminApi.updateCampusSettings({
                      welcomeTreasury: welcomeTreasuryDraft.trim() || null,
                      scholarshipWei,
                    });
                    setNotice(res.audit.summary);
                    await loadAll(true);
                  });
                }}
              >
                <div className="admin-field">
                  <label htmlFor="welcome-treasury-input">Ví quỹ chào mừng (CAMPUS_TREASURY_ADDRESS override)</label>
                  <input
                    id="welcome-treasury-input"
                    className="admin-input admin-input-mono"
                    placeholder="Để trống để dùng mặc định .env"
                    value={welcomeTreasuryDraft}
                    onChange={(e) => setWelcomeTreasuryDraft(e.target.value)}
                    disabled={busyKey !== null}
                  />
                </div>
                <div className="admin-field">
                  <label htmlFor="scholarship-default-input">Mức học bổng FOOD mặc định (CAMPUS)</label>
                  <input
                    id="scholarship-default-input"
                    className="admin-input admin-input-mono"
                    value={scholarshipDefaultDraft}
                    onChange={(e) => setScholarshipDefaultDraft(e.target.value)}
                    disabled={busyKey !== null}
                  />
                </div>
                <button type="submit" className="secondary-btn" disabled={busyKey !== null}>
                  {busyKey === "campus-settings" ? "Đang lưu…" : "Lưu tham số Campus"}
                </button>
              </form>
            </article>

            <article className="admin-card">
              <div className="admin-card-head">
                <div>
                  <h3>Allowlist mở rộng trên CampusPaymentRegistry</h3>
                  <p className="admin-card-desc">Bật hoặc tắt trực tiếp quyền nhận tiền của bất kỳ ví merchant nào cho PARKING hoặc FOOD.</p>
                </div>
              </div>
              <form
                className="admin-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!allowlistMerchant.trim()) return;
                  void runAction("registry-allowlist", async () => {
                    const res = await adminApi.setRegistryAllowlist({
                      merchant: allowlistMerchant.trim(),
                      category: allowlistCategory,
                      allowed: allowlistAllowed,
                    });
                    trackHash(res.txHash, res.audit.summary);
                    setAllowlistMerchant("");
                    await loadAll(true);
                  });
                }}
              >
                <div className="admin-field">
                  <label htmlFor="allowlist-merchant">Địa chỉ ví merchant (0x...)</label>
                  <input
                    id="allowlist-merchant"
                    className="admin-input admin-input-mono"
                    placeholder="0x..."
                    value={allowlistMerchant}
                    onChange={(e) => setAllowlistMerchant(e.target.value)}
                    disabled={busyKey !== null}
                  />
                </div>
                <div className="admin-inline-row">
                  <select
                    className="admin-select"
                    style={{ maxWidth: "11rem" }}
                    value={allowlistCategory}
                    onChange={(e) => setAllowlistCategory(e.target.value as "PARKING" | "FOOD")}
                  >
                    <option value="PARKING">PARKING (Bãi xe)</option>
                    <option value="FOOD">FOOD (Nhà ăn)</option>
                  </select>
                  <select
                    className="admin-select"
                    style={{ maxWidth: "12rem" }}
                    value={allowlistAllowed ? "allow" : "deny"}
                    onChange={(e) => setAllowlistAllowed(e.target.value === "allow")}
                  >
                    <option value="allow">Bật quyền nhận (true)</option>
                    <option value="deny">Tắt quyền nhận (false)</option>
                  </select>
                </div>
                <button type="submit" className="secondary-btn" disabled={!allowlistMerchant.trim() || busyKey !== null}>
                  {busyKey === "registry-allowlist" ? "Đang gửi…" : "Gửi setMerchantCategory"}
                </button>
              </form>
            </article>
          </div>
        </section>
      ) : null}

      {tab === "students" ? (
        <section className="admin-form" aria-label="Quản lý tư cách sinh viên và SBT">
          <article className="admin-card">
            <div className="admin-card-head">
              <div>
                <h2>Tra cứu & thao tác nhanh theo địa chỉ ví bất kỳ</h2>
                <p className="admin-card-desc">Dán ví test mới để duyệt sinh viên, cấp thẻ SBT (-10%), mở khóa dịch vụ hoặc cấp CAMPUS gas ngay mà không cần sinh viên nộp form trước.</p>
              </div>
            </div>
            <form
              className="admin-inline-row"
              onSubmit={(e) => {
                e.preventDefault();
                void handleInspect();
              }}
            >
              <input
                className="admin-input admin-input-mono"
                style={{ flex: "1 1 20rem" }}
                placeholder="Nhập địa chỉ ví sinh viên (0x...)"
                value={inspectInput}
                onChange={(e) => setInspectInput(e.target.value)}
              />
              <button type="submit" className="primary-cta-btn" disabled={!inspectInput.trim() || busyKey !== null}>
                {busyKey === "inspect" ? "Đang đọc…" : "Kiểm tra ví"}
              </button>
            </form>

            {inspected ? (
              <div className="admin-student-card" style={{ background: "var(--bg-canvas)" }}>
                <div className="admin-student-top">
                  <div>
                    <HashChip value={inspected.wallet} start={12} end={10} copyLabel="Sao chép ví sinh viên" />
                    <p className="admin-card-desc">
                      {inspected.application ? `${inspected.application.studentCode} · ${inspected.application.program}` : "Chưa có hồ sơ Campus"}
                    </p>
                  </div>
                  <div className="admin-student-badges">
                    <span className={statusPillClass(inspected.application?.status)}>
                      Hồ sơ: {inspected.application?.status ?? "CHƯA CÓ"}
                    </span>
                    <span className={inspected.onChain.sbtTier === 1 ? "admin-pill admin-pill-ok" : "admin-pill"}>
                      SBT: {inspected.onChain.sbtTier === 1 ? `Tier 1 (-10%) #${inspected.onChain.sbtTokenId}` : inspected.onChain.sbtTokenId && inspected.onChain.sbtTokenId !== "0" ? `Hết hạn #${inspected.onChain.sbtTokenId}` : "Chưa cấp"}
                    </span>
                    <span className={inspected.libraryAccount?.held ? "admin-pill admin-pill-danger" : inspected.libraryAccount?.enabled ? "admin-pill admin-pill-ok" : "admin-pill"}>
                      Dịch vụ: {inspected.libraryAccount ? (inspected.libraryAccount.held ? "Đang Hold" : inspected.libraryAccount.enabled ? "Đã mở" : "Đang khóa") : "Chưa kích hoạt"}
                    </span>
                  </div>
                </div>

                <div className="admin-student-metrics">
                  <div className="admin-metric-cell">
                    <span>Số dư ví</span>
                    <strong>{formatWeiSafe(inspected.onChain.balanceWei)}</strong>
                  </div>
                  <div className="admin-metric-cell">
                    <span>Học bổng FOOD</span>
                    <strong>{formatWeiSafe(inspected.onChain.foodGrantBalanceWei)}</strong>
                  </div>
                  <div className="admin-metric-cell">
                    <span>Hạn thẻ SBT</span>
                    <strong>{formatUnix(inspected.onChain.sbtExpiresAt)}</strong>
                  </div>
                  <div className="admin-metric-cell">
                    <span>Library Hold</span>
                    <strong>{inspected.libraryAccount?.blockingLoanIds.length ?? 0} khoản</strong>
                  </div>
                </div>

                <div className="admin-grid-2">
                  <div className="admin-form">
                    <div className="admin-inline-row">
                      <input
                        className="admin-input"
                        style={{ flex: "1 1 8rem" }}
                        placeholder="Mã SV (tùy chọn, vd SV2026-01)"
                        value={inspectCode}
                        onChange={(e) => setInspectCode(e.target.value)}
                      />
                      <input
                        className="admin-input"
                        style={{ flex: "1 1 10rem" }}
                        placeholder="Khoa / Ngành (tùy chọn)"
                        value={inspectProgram}
                        onChange={(e) => setInspectProgram(e.target.value)}
                      />
                    </div>
                    <div className="admin-inline-row">
                      <button type="button" className="primary-cta-btn" disabled={busyKey !== null} onClick={() => void handleApproveStudent(inspected.wallet, true, inspectCode, inspectProgram)}>
                        Duyệt SV & Mở dịch vụ
                      </button>
                      <button type="button" className="admin-danger-btn" disabled={busyKey !== null} onClick={() => void handleApproveStudent(inspected.wallet, false, inspectCode, inspectProgram)}>
                        Từ chối SV
                      </button>
                      <button type="button" className="secondary-btn" disabled={busyKey !== null} onClick={() => void handleToggleAccess(inspected.wallet, !(inspected.libraryAccount?.enabled ?? false), false)}>
                        {inspected.libraryAccount?.enabled ? "Khóa dịch vụ" : "Mở dịch vụ"}
                      </button>
                      {inspected.libraryAccount?.held ? (
                        <button type="button" className="secondary-btn" disabled={busyKey !== null} onClick={() => void handleToggleAccess(inspected.wallet, undefined, true)}>
                          Gỡ Hold test
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="admin-form">
                    <div className="admin-inline-row">
                      <label htmlFor="sbt-days" style={{ fontSize: "0.83rem", fontWeight: 600 }}>Hạn SBT (ngày):</label>
                      <input
                        id="sbt-days"
                        className="admin-input admin-input-mono"
                        style={{ width: "5.5rem" }}
                        value={sbtDays}
                        onChange={(e) => setSbtDays(e.target.value)}
                      />
                      <button type="button" className="primary-cta-btn" disabled={busyKey !== null} onClick={() => void handleMintSbt(inspected.wallet, Boolean(inspected.onChain.sbtTokenId && inspected.onChain.sbtTokenId !== "0"))}>
                        {inspected.onChain.sbtTokenId && inspected.onChain.sbtTokenId !== "0" ? "Cấp lại SBT (-10%)" : "Cấp SBT (-10%)"}
                      </button>
                      {inspected.onChain.sbtTokenId && inspected.onChain.sbtTokenId !== "0" ? (
                        <button type="button" className="admin-danger-btn" disabled={busyKey !== null} onClick={() => void handleRevokeSbt(inspected.wallet)}>
                          Thu hồi SBT
                        </button>
                      ) : null}
                    </div>
                    <div className="admin-inline-row">
                      <label htmlFor="fund-campus-amount" style={{ fontSize: "0.83rem", fontWeight: 600 }}>Cấp CAMPUS test:</label>
                      <input
                        id="fund-campus-amount"
                        className="admin-input admin-input-mono"
                        style={{ width: "6.5rem" }}
                        value={fundAmount}
                        onChange={(e) => setFundAmount(e.target.value)}
                      />
                      <div className="admin-preset-row">
                        {["20", "50", "100"].map((val) => (
                          <button key={val} type="button" className="admin-preset-btn" onClick={() => setFundAmount(val)}>
                            {val}
                          </button>
                        ))}
                      </div>
                      <button type="button" className="secondary-btn" disabled={busyKey !== null} onClick={() => void handleFundCampus(inspected.wallet, fundAmount)}>
                        Bắn CAMPUS
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </article>

          <article className="admin-card">
            <div className="admin-toolbar">
              <div>
                <h2>Danh sách tài khoản & hồ sơ sinh viên ({filteredStudents.length})</h2>
                <p className="admin-card-desc">Hiển thị đồng thời trạng thái hồ sơ Campus, quyền truy cập dịch vụ và thẻ SBT on-chain.</p>
              </div>
              <div className="admin-inline-row">
                <input
                  className="admin-input"
                  style={{ width: "16rem" }}
                  placeholder="Tìm theo ví, mã SV, khoa…"
                  value={studentQuery}
                  onChange={(e) => setStudentQuery(e.target.value)}
                />
                <select className="admin-select" style={{ width: "11rem" }} value={studentFilter} onChange={(e) => setStudentFilter(e.target.value as StudentFilter)}>
                  <option value="all">Tất cả</option>
                  <option value="pending">Chờ duyệt</option>
                  <option value="approved">Đã duyệt</option>
                  <option value="sbt">Đang có SBT</option>
                  <option value="held">Đang bị Hold</option>
                </select>
              </div>
            </div>

            {!filteredStudents.length ? (
              <p className="admin-card-desc">Chưa có sinh viên nào khớp bộ lọc. Bạn có thể nhập ví test ở ô tra cứu phía trên.</p>
            ) : (
              <div className="admin-student-list">
                {filteredStudents.map((st) => (
                  <div className="admin-student-card" key={st.wallet}>
                    <div className="admin-student-top">
                      <div>
                        <div className="admin-inline-row">
                          <HashChip value={st.wallet} start={10} end={8} copyLabel="Sao chép địa chỉ ví" />
                          {st.application ? <strong>{st.application.studentCode}</strong> : null}
                          {st.application ? <span className="admin-card-desc" style={{ margin: 0 }}>· {st.application.program}</span> : null}
                        </div>
                      </div>
                      <div className="admin-student-badges">
                        <span className={statusPillClass(st.application?.status)}>SV: {st.application?.status ?? "CHƯA NỘP"}</span>
                        <span className={st.onChain.sbtTier === 1 ? "admin-pill admin-pill-ok" : "admin-pill"}>
                          SBT: {st.onChain.sbtTier === 1 ? `#${st.onChain.sbtTokenId} (-10%)` : "Không"}
                        </span>
                        <span className={st.libraryAccount?.held ? "admin-pill admin-pill-danger" : st.libraryAccount?.enabled ? "admin-pill admin-pill-ok" : "admin-pill"}>
                          {st.libraryAccount ? (st.libraryAccount.held ? "Đang Hold" : st.libraryAccount.enabled ? "Dịch vụ ON" : "Dịch vụ OFF") : "Chưa mở DV"}
                        </span>
                      </div>
                    </div>

                    <div className="admin-student-metrics">
                      <div className="admin-metric-cell">
                        <span>Số dư ví</span>
                        <strong>{formatWeiSafe(st.onChain.balanceWei)}</strong>
                      </div>
                      <div className="admin-metric-cell">
                        <span>Học bổng FOOD</span>
                        <strong>{formatWeiSafe(st.onChain.foodGrantBalanceWei)}</strong>
                      </div>
                      <div className="admin-metric-cell">
                        <span>Đơn học bổng</span>
                        <strong>{st.scholarship?.status ?? "Chưa đăng ký"}</strong>
                      </div>
                      <div className="admin-metric-cell">
                        <span>Hạn SBT</span>
                        <strong>{formatUnix(st.onChain.sbtExpiresAt)}</strong>
                      </div>
                    </div>

                    <div className="admin-inline-row">
                      {st.application?.status !== "APPROVED" ? (
                        <button type="button" className="primary-cta-btn" disabled={busyKey !== null} onClick={() => void handleApproveStudent(st.wallet, true)}>
                          Duyệt SV + Mở DV
                        </button>
                      ) : null}
                      {st.application?.status === "PENDING" ? (
                        <button type="button" className="admin-danger-btn" disabled={busyKey !== null} onClick={() => void handleApproveStudent(st.wallet, false)}>
                          Từ chối
                        </button>
                      ) : null}
                      <button type="button" className="secondary-btn" disabled={busyKey !== null} onClick={() => void handleMintSbt(st.wallet, Boolean(st.onChain.sbtTokenId && st.onChain.sbtTokenId !== "0"))}>
                        {st.onChain.sbtTokenId && st.onChain.sbtTokenId !== "0" ? "Cấp lại SBT" : "Cấp SBT"}
                      </button>
                      {st.onChain.sbtTokenId && st.onChain.sbtTokenId !== "0" ? (
                        <button type="button" className="admin-danger-btn" disabled={busyKey !== null} onClick={() => void handleRevokeSbt(st.wallet)}>
                          Thu hồi SBT
                        </button>
                      ) : null}
                      {st.libraryAccount?.held ? (
                        <button type="button" className="secondary-btn" disabled={busyKey !== null} onClick={() => void handleToggleAccess(st.wallet, undefined, true)}>
                          Gỡ Hold
                        </button>
                      ) : null}
                      <button type="button" className="secondary-btn" onClick={() => { setGrantWallet(st.wallet); setTab("scholarships"); }}>
                        Cấp FOOD →
                      </button>
                      <button type="button" className="secondary-btn" onClick={() => void handleInspect(st.wallet)}>
                        Chi tiết
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>
        </section>
      ) : null}

      {tab === "scholarships" ? (
        <section className="admin-form" aria-label="Duyệt và giải ngân học bổng FOOD">
          <article className="admin-card">
            <div className="admin-card-head">
              <div>
                <h2>Giải ngân học bổng FOOD vào Vault</h2>
                <p className="admin-card-desc">Cấp ngân sách FOOD (chỉ tiêu tại Nhà ăn đang hoạt động) trực tiếp qua PurposeBoundGrantVault.grant bằng ví grantIssuer trên VM.</p>
              </div>
              <span className="admin-pill admin-pill-ok">Danh mục: FOOD</span>
            </div>
            <form
              className="admin-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!grantWallet.trim()) return;
                void handleIssueFoodGrant(grantWallet.trim(), grantAmount, grantMarkApproved);
              }}
            >
              <div className="admin-grid-2">
                <div className="admin-field">
                  <label htmlFor="grant-wallet-input">Ví sinh viên nhận học bổng FOOD (0x...)</label>
                  <input
                    id="grant-wallet-input"
                    className="admin-input admin-input-mono"
                    placeholder="0x..."
                    value={grantWallet}
                    onChange={(e) => setGrantWallet(e.target.value)}
                    disabled={busyKey !== null}
                  />
                </div>
                <div className="admin-field">
                  <label htmlFor="grant-amount-input">Số lượng CAMPUS cấp vào Vault FOOD</label>
                  <input
                    id="grant-amount-input"
                    className="admin-input admin-input-mono"
                    value={grantAmount}
                    onChange={(e) => setGrantAmount(e.target.value)}
                    disabled={busyKey !== null}
                  />
                  <div className="admin-preset-row">
                    {["200", "500", "1000", "5000"].map((val) => (
                      <button key={val} type="button" className="admin-preset-btn" onClick={() => setGrantAmount(val)}>
                        {val} CAMPUS
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <label className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={grantMarkApproved}
                  onChange={(e) => setGrantMarkApproved(e.target.checked)}
                />
                Đồng thời đánh dấu hồ sơ học bổng Campus là Đã duyệt (nếu sinh viên đã được xác minh)
              </label>
              <div>
                <button type="submit" className="primary-cta-btn" disabled={!grantWallet.trim() || !grantAmount.trim() || busyKey !== null}>
                  {busyKey?.startsWith("grant:") ? "Đang gửi giao dịch…" : "Giải ngân học bổng FOOD"}
                </button>
              </div>
            </form>
          </article>

          <article className="admin-card">
            <div className="admin-card-head">
              <div>
                <h2>Hồ sơ & số dư học bổng FOOD ({scholarshipList.length})</h2>
                <p className="admin-card-desc">Duyệt hoặc từ chối đơn đăng ký học bổng từ trang sinh viên và giải ngân trực tiếp.</p>
              </div>
            </div>
            {!scholarshipList.length ? (
              <p className="admin-card-desc">Chưa có hồ sơ hoặc số dư học bổng FOOD nào. Dùng biểu mẫu phía trên để cấp nhanh cho ví test.</p>
            ) : (
              <div className="admin-student-list">
                {scholarshipList.map((item) => (
                  <div className="admin-student-card" key={item.wallet}>
                    <div className="admin-student-top">
                      <div>
                        <div className="admin-inline-row">
                          <HashChip value={item.wallet} start={10} end={8} copyLabel="Sao chép ví sinh viên" />
                          {item.application ? <strong>{item.application.studentCode}</strong> : null}
                        </div>
                        <p className="admin-card-desc">
                          Diện: {item.scholarship ? (item.scholarship.category === "MERIT" ? "Khuyến khích học tập" : "Hỗ trợ sinh viên") : "Cấp trực tiếp"}
                        </p>
                      </div>
                      <div className="admin-student-badges">
                        <span className={statusPillClass(item.scholarship?.status)}>Hồ sơ: {item.scholarship?.status ?? "CHƯA CÓ"}</span>
                        <span className="admin-pill admin-pill-ok">Vault FOOD: {formatWeiSafe(item.onChain.foodGrantBalanceWei)}</span>
                      </div>
                    </div>
                    <div className="admin-inline-row">
                      {item.scholarship?.status !== "APPROVED" ? (
                        <button type="button" className="primary-cta-btn" disabled={busyKey !== null} onClick={() => void handleReviewScholarship(item.wallet, true, true)}>
                          Duyệt hồ sơ học bổng
                        </button>
                      ) : null}
                      {item.scholarship?.status === "PENDING" ? (
                        <button type="button" className="admin-danger-btn" disabled={busyKey !== null} onClick={() => void handleReviewScholarship(item.wallet, false, false)}>
                          Từ chối
                        </button>
                      ) : null}
                      <button type="button" className="secondary-btn" disabled={busyKey !== null} onClick={() => void handleIssueFoodGrant(item.wallet, grantAmount || "1000", true)}>
                        Giải ngân {grantAmount || "1000"} CAMPUS FOOD
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>
        </section>
      ) : null}

      {tab === "audit" && overview ? (
        <section className="admin-form" aria-label="Signers và nhật ký thao tác">
          <article className="admin-card">
            <div className="admin-card-head">
              <div>
                <h2>Trạng thái Operator Signers trên GCP VM</h2>
                <p className="admin-card-desc">Các private key chỉ nằm trong biến môi trường backend trên VM để ký giao dịch on-chain thay mặt đội ngũ test.</p>
              </div>
            </div>
            <div className="admin-signer-grid">
              {overview.signers.map((signer) => {
                const lowGas = signer.balanceWei !== null && BigInt(signer.balanceWei) < (BigInt(10) ** BigInt(18));
                return (
                  <div className="admin-signer-card" key={signer.role}>
                    <div className="admin-card-head">
                      <strong>{signer.label}</strong>
                      <span
                        className={
                          !signer.configured
                            ? "admin-pill admin-pill-warn"
                            : signer.matchesOnChain === false
                              ? "admin-pill admin-pill-danger"
                              : "admin-pill admin-pill-ok"
                        }
                      >
                        {!signer.configured ? "Chưa cấu hình" : signer.matchesOnChain === false ? "Lệch địa chỉ" : "Sẵn sàng"}
                      </span>
                    </div>
                    <div className="admin-kv-row">
                      <span>Signer VM:</span>
                      <span>{signer.signerAddress ? <HashChip value={signer.signerAddress} start={8} end={6} copyLabel="Sao chép signer" /> : "—"}</span>
                    </div>
                    {signer.expectedAddress ? (
                      <div className="admin-kv-row">
                        <span>Quyền on-chain:</span>
                        <span><HashChip value={signer.expectedAddress} start={8} end={6} copyLabel="Sao chép địa chỉ on-chain" /></span>
                      </div>
                    ) : null}
                    <div className="admin-kv-row">
                      <span>Số dư gas:</span>
                      <strong style={{ color: lowGas ? "var(--danger-ink)" : undefined }}>
                        {formatWeiSafe(signer.balanceWei)}
                      </strong>
                    </div>
                  </div>
                );
              })}
            </div>
          </article>

          <article className="admin-card">
            <div className="admin-card-head">
              <div>
                <h2>Nhật ký thao tác gần đây ({audit.length})</h2>
                <p className="admin-card-desc">Mọi thay đổi ví đích, duyệt sinh viên, cấp SBT và giải ngân học bổng đều được lưu tại SQLite trên VM.</p>
              </div>
            </div>
            {!audit.length ? (
              <p className="admin-card-desc">Chưa có thao tác quản trị nào được ghi nhận.</p>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Thời gian</th>
                      <th>Hành động</th>
                      <th>Chi tiết</th>
                      <th>Giao dịch</th>
                      <th>Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((entry) => (
                      <tr key={entry.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{formatUnix(entry.createdAt)}</td>
                        <td><code>{entry.action}</code></td>
                        <td>{entry.summary}</td>
                        <td>
                          {entry.txHash ? (
                            <div className="admin-inline-row">
                              <HashChip value={entry.txHash} start={8} end={6} copyLabel="Sao chép txHash" />
                              {entry.status === "SUBMITTED" ? (
                                <button
                                  type="button"
                                  className="admin-preset-btn"
                                  onClick={() =>
                                    void runAction(`poll:${entry.id}`, async () => {
                                      const st = await adminApi.txStatus(entry.txHash!);
                                      setTrackedTx(st);
                                      await loadAll(true);
                                    })
                                  }
                                >
                                  Kiểm tra
                                </button>
                              ) : null}
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td><span className={statusPillClass(entry.status)}>{entry.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        </section>
      ) : null}
    </div>
  );
}
