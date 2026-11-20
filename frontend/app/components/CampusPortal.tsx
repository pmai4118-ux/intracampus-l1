"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CampusProfile, CampusPayout } from "@intracampus/network";
import { WalletSession, useCampusWallet } from "../student/WalletPanel";
import { formatWalletBalance } from "../../lib/chains";
import { signInLibraryStudent } from "../../lib/library-session";
import { campusApi, campusLogin, campusMe, campusMessage, campusStatus, releaseCampusPayout, sendCampusPayout, type CampusMe, type CampusPayoutRecovery } from "../../lib/campus";
import PageHeading from "./PageHeading";
import Icon from "./Icon";

type Mode = "login" | "student" | "school";
export default function CampusPortal({ mode }: { mode: Mode }) {
  return <WalletSession><BoundPortal mode={mode} /></WalletSession>;
}
function BoundPortal({ mode }: { mode: Mode }) {
  const { state } = useCampusWallet();
  return <Portal key={`${state.address}:${state.chainId}:${mode}`} mode={mode} />;
}
function ReviewControls({ kind, wallet, busy, review }: { kind: "STUDENT" | "SCHOLARSHIP"; wallet: string; busy: boolean; review: (approve: boolean, reason: string) => void }) {
  const [checked, setChecked] = useState(false), [reason, setReason] = useState("INCOMPLETE");
  return <div className="campus-review-controls"><label className="campus-checkbox"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />{kind === "STUDENT" ? "Tôi đã đối chiếu mã sinh viên và xác nhận ví được sinh viên ủy quyền." : "Tôi đã đối chiếu tiêu chí và hồ sơ học bổng của sinh viên."}</label>
    <button className="primary-cta-btn" disabled={busy || !checked} onClick={() => review(true, "VERIFIED")}>Duyệt {kind === "STUDENT" ? "sinh viên" : "học bổng"}</button>
    <label htmlFor={`reason-${wallet}-${kind}`}>Nếu cần bổ sung</label><select id={`reason-${wallet}-${kind}`} value={reason} onChange={e => setReason(e.target.value)}><option value="INCOMPLETE">Hồ sơ chưa đủ</option><option value="IDENTITY_MISMATCH">Thông tin chưa khớp</option><option value="NOT_ELIGIBLE">Chưa đủ điều kiện</option></select>
    <button className="secondary-btn" disabled={busy} onClick={() => review(false, reason)}>Yêu cầu bổ sung</button>
  </div>;
}
function Portal({ mode }: { mode: Mode }) {
  const { state: wallet, controller } = useCampusWallet();
  const [me, setMe] = useState<CampusMe | null>(null), [profiles, setProfiles] = useState<CampusProfile[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [studentCode, setCode] = useState(""), [program, setProgram] = useState(""), [category, setCategory] = useState("MERIT");
  const [payout, setPayout] = useState<CampusPayout | null>(null), [recoveryHash, setRecoveryHash] = useState("");
  const [recoveries, setRecoveries] = useState<Record<string, CampusPayoutRecovery>>({});
  const active = useRef(true), running = useRef(false);
  async function refresh() {
    if (!wallet.address) return;
    const result = await campusMe(wallet.address);
    if (!active.current) return;
    setMe(result);
    if (mode === "school" && result.school) {
      const data = await campusApi("reviews"); if (active.current) setProfiles(data.profiles);
    }
  }
  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError(""); setNotice("");
    try { await work(); } catch (e) { if (active.current) {
      const code = e instanceof Error ? e.message : "SERVICE_UNAVAILABLE";
      if (["UNAUTHENTICATED", "WALLET_SESSION_CHANGED"].includes(code)) { setMe(null); setProfiles([]); setPayout(null); setRecoveries({}); }
      setError(campusMessage(code));
    } } finally { running.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => {
    active.current = true;
    if (wallet.address) void refresh().catch(e => { if (active.current && !["UNAUTHENTICATED", "WALLET_SESSION_CHANGED"].includes(e.message)) setError(campusMessage(e.message)); });
    return () => { active.current = false; };
    // The enclosing component remounts on every wallet/chain change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ready = wallet.address && wallet.chainId === BigInt(20261);
  const own = me?.profile;
  const welcome = own?.payouts.find(p => p.kind === "WELCOME");
  async function prepare(profile: CampusProfile, kind: CampusPayout["kind"]) {
    if (!profile.application || !wallet.address) return;
    await campusMe(wallet.address);
    const result = await campusApi("payouts", { wallet: profile.application.wallet, kind });
    if (active.current) { setPayout(result); setRecoveryHash(result.txHash ?? ""); }
  }
  async function reconcile(p: CampusPayout, hash: string) {
    const result = await campusApi(`payouts/${p.id}/reconcile`, { txHash: hash });
    if (active.current) setPayout(result);
    await refresh();
  }
  async function logout() {
    await campusApi("auth/logout", {});
    if (active.current) { setMe(null); setProfiles([]); setPayout(null); setRecoveries({}); }
  }
  return <div className="campus-onboarding">
    <PageHeading eyebrow={mode === "school" ? "CỔNG NHÀ TRƯỜNG" : "CHÀO MỪNG ĐẾN INTRACAMPUS"}
      title={mode === "school" ? "Xác nhận để mở cơ hội." : mode === "login" ? "Campus bắt đầu từ bạn." : "Hồ sơ sinh viên của bạn."}
      description={mode === "school" ? "Đối chiếu hồ sơ, duyệt sinh viên và giải ngân học bổng bằng ví được phân quyền." : "Đăng nhập bằng ví. Xác minh sinh viên. Nhận quyền lợi campus."} icon={mode === "school" ? "shield" : "graduation"} />
    <div className="campus-portal-links"><Link href="/login">Đăng nhập</Link><Link href="/student/verification">Sinh viên</Link><Link href="/staff/students">Nhà trường</Link></div>
    {me && mode !== "login" ? <section className="surface-panel campus-session-bar">
      <div><span className="panel-eyebrow">ĐÃ ĐĂNG NHẬP · INTRACAMPUS L1</span><code className="campus-session-address">{me.wallet}</code><span className="verified-badge">{me.school ? "VÍ ĐƯỢC NHÀ TRƯỜNG PHÂN QUYỀN" : "ĐÃ XÁC MINH QUYỀN SỞ HỮU VÍ"}</span></div>
      <div className="campus-login-actions"><button className="secondary-btn" disabled={busy} onClick={() => void run(refresh)}>Làm mới trạng thái</button><button className="secondary-btn" disabled={busy} onClick={() => void run(logout)}>Đăng xuất</button><button className="text-action-btn" onClick={() => controller.disconnect()}>Ngắt kết nối ví</button></div>
    </section> : <div className="campus-onboarding-grid">
      <aside className="campus-welcome-card"><Icon name="graduation" /><p className="eyebrow">MỘT KẾT NỐI. NHIỀU KHỞI ĐẦU.</p><h2>Ví của bạn.<br />Quyền lợi của bạn.</h2>
        <ol><li><strong>01 · Ký đăng nhập</strong><span>Chứng minh bạn sở hữu ví; không chuyển tiền, không tốn gas.</span></li><li><strong>02 · Nhà trường xác nhận</strong><span>Hồ sơ được đối chiếu với dữ liệu sinh viên của trường.</span></li><li><strong>03 · Bắt đầu với 20 CAMPUS</strong><span>Quà chào mừng một lần, sau khi hồ sơ đã được duyệt và ví quỹ xác nhận cấp.</span></li></ol>
        <p>Học bổng FOOD được xét riêng và chỉ dùng theo phạm vi căn-tin đã cấp.</p>
      </aside>
      <section className="surface-panel campus-login-card" aria-busy={busy}>
        <span className="panel-eyebrow">{me ? "PHIÊN ĐĂNG NHẬP" : "KẾT NỐI & XÁC NHẬN"}</span><h2>{me ? "Đã đăng nhập bằng ví" : "Đăng nhập IntraCampus"}</h2>
        <p>{wallet.status === "no-wallet" ? "Mở bằng Core/MetaMask hoặc cài tiện ích ví trong trình duyệt, sau đó tải lại trang." : "Kết nối ví và ký thông điệp để đăng nhập an toàn."}</p>
        <code className="campus-wallet-address">{wallet.address ?? "Chưa kết nối ví"}</code>
        <span className="network-pill">{wallet.chainId === BigInt(20261) ? "IntraCampus L1 · 20261" : "Cần mạng IntraCampus L1 · 20261"}</span>
        <div className="campus-login-actions">
          {!wallet.address ? <button className="primary-cta-btn" disabled={busy || wallet.status === "no-wallet"} onClick={() => void run(() => controller.connect())}>Kết nối ví</button> : wallet.chainId !== BigInt(20261) ? <button className="primary-cta-btn" disabled={busy} onClick={() => void run(() => controller.switchNetwork())}>Chuyển sang IntraCampus L1</button> : null}
          {!me ? <button className="primary-cta-btn" disabled={!ready || busy} onClick={() => void run(async () => {
            const result = await campusLogin(wallet.address!, (account, message) => controller.signMessage(account, message));
            if (active.current) setMe(result); await refresh();
          })}>{busy ? "Đang xử lý…" : "Ký đăng nhập bằng ví"}</button> : <>
            <span className="verified-badge">{me.school ? "VÍ ĐƯỢC NHÀ TRƯỜNG PHÂN QUYỀN" : "ĐÃ XÁC MINH QUYỀN SỞ HỮU VÍ"}</span>
            <Link className="primary-cta-btn" href={me.school ? "/staff/students" : "/student/verification"}>Mở {me.school ? "cổng nhà trường" : "hồ sơ sinh viên"}</Link>
            <button className="secondary-btn" disabled={busy} onClick={() => void run(refresh)}>Làm mới trạng thái</button>
            <button className="secondary-btn" disabled={busy} onClick={() => void run(logout)}>Đăng xuất</button>
          </>}
          {wallet.address ? <button className="text-action-btn" onClick={() => controller.disconnect()}>Ngắt kết nối ví</button> : null}
        </div><p className="metric-note">Ký đăng nhập chưa xác nhận tư cách sinh viên. Quyền duyệt thuộc ví do nhà trường cấu hình.</p>
      </section>
    </div>}
    {error ? <p className="wallet-warning" role="alert">{error}</p> : null}{notice ? <p className="verified-badge" role="status">{notice}</p> : null}
    {me && mode !== "school" ? <div className="campus-application-grid">
      <section className="surface-panel"><span className="panel-eyebrow">01 · XÁC MINH SINH VIÊN</span><h2>Thông tin học tập</h2>
        {own?.application ? <><p className="network-pill">{campusStatus[own.application.status]}</p><p>Mã sinh viên: <strong>{own.application.studentCode}</strong></p><p>{own.application.program}</p>{own.application.reason && own.application.status === "REJECTED" ? <p>Nhà trường yêu cầu đối chiếu hoặc bổ sung. Hãy sửa thông tin và gửi lại.</p> : null}</> : <p>Gửi mã sinh viên để nhà trường đối chiếu. Không gửi căn cước hoặc khóa ví.</p>}
        {!own?.application || own.application.status === "REJECTED" ? <form onSubmit={event => { event.preventDefault(); void run(async () => { await campusMe(wallet.address!); await campusApi("applications", { studentCode: studentCode.trim().toUpperCase(), program: program.trim() }); await refresh(); }); }}>
          <label htmlFor="campus-student-code">Mã sinh viên</label><input id="campus-student-code" value={studentCode} onChange={e => setCode(e.target.value)} required maxLength={32} pattern="[A-Za-z0-9-]{4,32}" autoComplete="off" />
          <label htmlFor="campus-program">Khoa / chương trình học</label><input id="campus-program" value={program} onChange={e => setProgram(e.target.value)} required maxLength={100} />
          <button className="primary-cta-btn" disabled={busy} type="submit">Gửi hồ sơ xác minh</button></form> : null}
        {own?.application?.status === "APPROVED" ? <button className="secondary-btn" disabled={busy || !wallet.canProceed} onClick={() => void run(async () => { await campusMe(wallet.address!); await campusApi("activate", {}); const result = await signInLibraryStudent(wallet.address!, (a, m) => controller.signMessage(a, m)); if (result.status !== "ready" && result.status !== "held") throw Error("SERVICE_UNAVAILABLE"); if (active.current) setNotice("Đã kích hoạt đăng nhập dịch vụ sinh viên. Bạn có thể mở ví, nhà ăn và thư viện."); })}>Kích hoạt dịch vụ sinh viên</button> : null}
      </section>
      <section className="surface-panel"><span className="panel-eyebrow">02 · QUÀ CHÀO MỪNG</span><h2>20 CAMPUS khởi đầu</h2><p>Được nhà trường cấp một lần cho mỗi sinh viên đã xác minh. Tiền vào ví chỉ sau khi giao dịch thành công.</p>
        <p className="network-pill">{welcome?.status === "CONFIRMED" ? "Đã nhận · receipt đã xác minh" : welcome?.status === "FAILED" ? campusStatus.FAILED : welcome?.status === "PENDING" ? "Chờ đối chiếu giao dịch" : welcome?.status === "UNKNOWN" ? "Cần nhà trường đối chiếu kết quả" : own?.application?.status === "APPROVED" ? "Đủ điều kiện · chờ nhà trường cấp" : "Cần xác minh sinh viên trước"}</p>
        {own?.payouts.filter(p => p.kind === "WELCOME").map(p => <code className="tx-hash-code" key={p.id}>{p.txHash ?? "Chưa có giao dịch được xác nhận"}</code>)}
      </section>
      <section className="surface-panel"><span className="panel-eyebrow">03 · HỌC BỔNG FOOD</span><h2>Đăng ký xét học bổng</h2><p>Nhà trường xét điều kiện, sau đó ví có quyền cấp học bổng giải ngân vào vault FOOD.</p>
        {own?.scholarship ? <p className="network-pill">{campusStatus[own.scholarship.status]} · {own.payouts.some(p => p.kind === "SCHOLARSHIP" && p.status === "CONFIRMED") ? "Đã giải ngân" : "Chưa xác nhận giải ngân"}</p> : null}
        {!own?.scholarship || own.scholarship.status === "REJECTED" ? <form onSubmit={e => { e.preventDefault(); void run(async () => { await campusMe(wallet.address!); await campusApi("scholarships", { category }); await refresh(); }); }}><label htmlFor="scholarship-category">Diện xét học bổng</label><select id="scholarship-category" value={category} onChange={e => setCategory(e.target.value)}><option value="MERIT">Khuyến khích học tập</option><option value="SUPPORT">Hỗ trợ sinh viên</option></select><button className="primary-cta-btn" disabled={busy || own?.application?.status !== "APPROVED"}>Gửi đăng ký học bổng</button></form> : null}
      </section>
    </div> : null}
    {me && mode === "school" ? !me.school ? <section className="surface-panel"><h2>Chưa có quyền nhà trường</h2><p>Đường dẫn này không cấp quyền duyệt. Đăng nhập bằng ví do nhà trường phân quyền.</p></section> : <section className="surface-panel"><h2>Hồ sơ cần đối chiếu</h2><p>Đối chiếu dữ liệu chính thức của trường và xác nhận sinh viên sở hữu ví trước khi duyệt. Phê duyệt học bổng là bước riêng.</p>
      {!profiles.length ? <p>Chưa có hồ sơ sinh viên.</p> : <div className="campus-review-list">{profiles.map(profile => {
        const application = profile.application!;
        return <article className="campus-review-item" key={application.wallet}><h3>{application.studentCode} · {application.program}</h3><code className="tx-hash-code">{application.wallet}</code><p>{campusStatus[application.status]}</p>
          {application.status === "PENDING" ? <ReviewControls kind="STUDENT" wallet={application.wallet} busy={busy} review={(approve, reason) => void run(async () => { await campusMe(wallet.address!); await campusApi("reviews", { wallet: application.wallet, kind: "STUDENT", approve, reason }); await refresh(); })} /> : null}
          {application.status === "APPROVED" ? <button className="secondary-btn" disabled={busy} onClick={() => void run(() => prepare(profile, "WELCOME"))}>Xem lượt cấp 20 CAMPUS</button> : null}
          {profile.scholarship ? <div><h3>Học bổng · {profile.scholarship.category === "MERIT" ? "Khuyến khích học tập" : "Hỗ trợ sinh viên"}</h3><p>{campusStatus[profile.scholarship.status]}</p>
            {profile.scholarship.status === "PENDING" ? <ReviewControls kind="SCHOLARSHIP" wallet={application.wallet} busy={busy} review={(approve, reason) => void run(async () => { await campusMe(wallet.address!); await campusApi("reviews", { wallet: application.wallet, kind: "SCHOLARSHIP", approve, reason }); await refresh(); })} /> : null}
            {profile.scholarship.status === "APPROVED" ? <button className="secondary-btn" disabled={busy} onClick={() => void run(() => prepare(profile, "SCHOLARSHIP"))}>Xem lượt giải ngân FOOD</button> : null}</div> : null}
        </article>;
      })}</div>}
    </section> : null}
    {payout && mode === "school" && me?.school ? <section className="surface-panel campus-payout-review"><h2>Kiểm tra lượt cấp trước khi ký</h2>
      <dl><dt>Loại</dt><dd>{payout.kind === "WELCOME" ? "Quà chào mừng" : "Học bổng FOOD"}</dd><dt>Số tiền</dt><dd>{formatWalletBalance(BigInt(payout.value))} + gas từ ví cấp</dd><dt>Mạng</dt><dd>IntraCampus L1 · 20261</dd><dt>Ví cấp</dt><dd><code>{payout.from}</code></dd><dt>Sinh viên nhận</dt><dd><code>{payout.wallet}</code></dd><dt>Đích giao dịch</dt><dd><code>{payout.to}</code></dd><dt>Trạng thái</dt><dd>{payout.status === "PENDING" ? "Đang chờ xác minh" : campusStatus[payout.status]}</dd></dl>
      {payout.status === "PREPARED" ? <button className="primary-cta-btn" disabled={busy || !wallet.canProceed || payout.from.toLowerCase() !== wallet.address?.toLowerCase()} onClick={() => void run(async () => {
        await campusMe(wallet.address!);
        const result = await sendCampusPayout(payout, wallet.address!, (account, tx) => controller.sendTransaction(account, tx), {
          onPayout: value => { if (active.current) setPayout(value); },
          onRecovery: value => { if (active.current) setRecoveries(current => { const next = { ...current }; if (value) next[payout.id] = value; else delete next[payout.id]; return next; }); },
        });
        if (result.hash === null) { if (active.current) setNotice("Ví đã hủy hoặc chưa gửi giao dịch. Lượt cấp đã sẵn sàng để thử lại."); await refresh(); return; }
        if (active.current) setRecoveryHash(result.hash);
        await reconcile(result.payout, result.hash);
      })}>Xác nhận và mở ví cấp</button> : payout.status === "UNKNOWN" && !payout.txHash && recoveries[payout.id] ? <div>
        <p>Ví đã xác nhận chưa gửi giao dịch. Chưa nhận được xác nhận khôi phục từ máy chủ; bạn có thể thử lại bước khôi phục mà không gửi tiền.</p>
        <button className="secondary-btn" disabled={busy} onClick={() => void run(async () => {
          await campusMe(wallet.address!); const restored = await releaseCampusPayout(recoveries[payout.id]);
          if (active.current) { setPayout(restored); setRecoveries(current => { const next = { ...current }; delete next[payout.id]; return next; }); setNotice("Đã khôi phục lượt chưa gửi. Bạn có thể kiểm tra và mở ví lại."); }
          await refresh();
        })}>Khôi phục lượt chưa gửi</button>
      </div> : payout.status !== "CONFIRMED" ? <form onSubmit={e => { e.preventDefault(); void run(async () => { await campusMe(wallet.address!); await reconcile(payout, recoveryHash.trim()); }); }}>
        <p>Lượt cấp đã khóa để tránh gửi trùng. Nếu mất kết nối hoặc tải lại trang, mở lại lượt cấp này và tra hash từ lịch sử ví. Không tạo lượt cấp mới.</p><label htmlFor="campus-payout-hash">Hash giao dịch đã gửi</label><input id="campus-payout-hash" value={recoveryHash} onChange={e => setRecoveryHash(e.target.value)} required pattern="0x[0-9a-fA-F]{64}" /><button className="secondary-btn" disabled={busy}>Đối chiếu giao dịch</button></form> : <p className="verified-badge">Đã xác minh chuyển tiền thành công.</p>}
      {payout.txHash ? <code className="tx-hash-code">{payout.txHash}</code> : null}
    </section> : null}
  </div>;
}
