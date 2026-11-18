import { campusNetwork, type NetworkProbe } from "@intracampus/network";
import Link from "next/link";
import Icon, { type IconName } from "./components/Icon";

export const dynamic = "force-dynamic";

const labels = {
  ready: "RPC trả về đúng chain ID",
  "not-configured": "Chưa cấu hình RPC",
  "wrong-chain": "RPC đang trỏ sai mạng",
  unreachable: "Không đọc được RPC",
} satisfies Record<NetworkProbe["status"], string>;

async function getNetworkStatus() {
  try {
    const backend = process.env.BACKEND_URL ?? "http://127.0.0.1:4000";
    const response = await fetch(new URL("/api/network", backend), {
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
    });
    if (response.status !== 200 && response.status !== 503) return { ready: false, label: "Không đọc được trạng thái từ API" };
    const data = await response.json() as NetworkProbe;
    if (data.status === "ready" || data.status === "wrong-chain") {
      const head = data.latestBlock;
      if (!head || !Number.isSafeInteger(head.number) || !Number.isSafeInteger(data.headAgeSeconds)) {
        return { ready: false, label: "Chưa đọc được block mới nhất từ API" };
      }
      const age = data.headAgeSeconds < 0 ? `Timestamp block ở tương lai ${-data.headAgeSeconds} giây` : `Tuổi block: ${data.headAgeSeconds} giây`;
      return {
        ready: data.status === "ready",
        label: `${labels[data.status]} (${data.chainId}). Block ${head.number}. ${age}. Các thao tác sẽ kiểm tra độ mới của dữ liệu trước khi ký.`,
      };
    }
    return { ready: false, label: labels[data.status] ?? "Không đọc được trạng thái từ API" };
  } catch {
    return { ready: false, label: "Không kết nối được POS API" };
  }
}

export default async function Home() {
  const status = await getNetworkStatus();
  const services: { href: string; title: string; description: string; icon: IconName; color: string; label: string }[] = [
    { href: "/student", title: "Ví sinh viên", description: "Thanh toán QR, xem thẻ số và sử dụng voucher học bổng FOOD.", icon: "wallet", color: "green", label: "DÀNH CHO SINH VIÊN" },
    { href: "/student/canteen", title: "Nhà ăn campus", description: "Chọn món yêu thích, đặt bữa trưa và thanh toán bằng CAMPUS hoặc FOOD.", icon: "utensils", color: "peach", label: "NẠP NĂNG LƯỢNG" },
    { href: "/student/library", title: "Thư viện campus", description: "Tìm cuốn sách tiếp theo. Theo dõi lượt mượn và quản lý tiền cọc.", icon: "book", color: "gold", label: "HỌC TẬP MỖI NGÀY" },
    { href: "/pos", title: "Điểm thu & dịch vụ", description: "Tạo hóa đơn, hiển thị mã QR và theo dõi biên lai thanh toán.", icon: "store", color: "blue", label: "DÀNH CHO ĐIỂM THU" },
  ];
  return <div className="home-page">
    <section className="home-hero" aria-labelledby="home-title">
      <div className="hero-copy"><span className="hero-kicker"><span />CAMPUS LIFE, CONNECTED</span>
        <h1 id="home-title">Một chiếc ví.<br />Cả campus <span>của bạn.</span></h1>
        <p>Từ một lượt gửi xe, bữa trưa tại căn-tin đến cuốn sách yêu thích. Kết nối những điều quen thuộc với IntraCampus.</p>
        <div className="hero-actions"><Link href="/student" className="button-primary">Khám phá ví sinh viên<Icon name="arrow" /></Link>
          <Link href="/student/library" className="button-quiet">Ghé thư viện<Icon name="arrow" /></Link></div>
        <div className="hero-footnote"><Icon name="shield" /><span>Bạn kiểm soát ví. Mỗi giao dịch do bạn xác nhận.</span></div>
      </div>
      <div className="hero-visual" aria-hidden="true">
        <div className="orbit orbit-one" /><div className="orbit orbit-two" />
        <span className="visual-spark">✳</span><span className="visual-caption">YOUR CAMPUS.<br />YOUR CONNECTION.</span>
        <div className="campus-pass"><div className="pass-top"><span><Icon name="graduation" />IntraCampus</span><span>L1</span></div>
          <div className="pass-chip"><i /><i /><i /></div>
          <div className="pass-title">CAMPUS<br /><span>PASS</span><Icon name="leaf" /></div>
          <div className="pass-bottom"><span>VÍ · THẺ SỐ · DỊCH VỤ</span><span>2026</span></div>
        </div>
        <span className="visual-float float-qr"><span className="float-icon"><Icon name="qr" /></span><span>Quét. Xác nhận.<strong>Tiếp tục ngày của bạn.</strong></span></span>
        <span className="visual-float float-book"><Icon name="book" /><span>Thêm một trang mới.</span></span>
      </div>
    </section>
    <section className="home-services" aria-labelledby="services-title"><div className="section-heading"><div><p className="eyebrow">KHÔNG GIAN CỦA BẠN</p><h2 id="services-title">Hôm nay, bạn muốn làm gì?</h2></div><span className="section-caption">Mọi dịch vụ, cùng một kết nối.</span></div>
      <div className="service-cards">{services.map(service => <Link href={service.href} className={`service-card service-${service.color}`} key={service.href}>
        <div className="service-card-top"><span className="service-icon"><Icon name={service.icon} /></span><Icon className="service-arrow" name="arrow" /></div>
        <span className="service-kicker">{service.label}</span><h3>{service.title}</h3><p>{service.description}</p>
      </Link>)}</div>
    </section>
    <section className="home-network" aria-label="Trạng thái mạng"><div className="network-emblem"><Icon name="grid" /></div>
      <div><h2>{campusNetwork.name}</h2><p>Mạng dùng cho thanh toán và định danh campus</p></div>
      <dl><div><dt>Chain ID</dt><dd>{campusNetwork.chainId}</dd></div><div><dt>Đồng gốc</dt><dd>{campusNetwork.nativeCurrency.symbol}</dd></div></dl>
      <span className={`network-health ${status.ready ? "health-ready" : "health-pending"}`}><span />{status.label}</span>
    </section>
    <p className="home-demo-note">Môi trường thử nghiệm UniHack 2026. Số dư và biên lai chỉ được xác nhận sau khi đọc dữ liệu từ mạng.</p>
  </div>;
}
