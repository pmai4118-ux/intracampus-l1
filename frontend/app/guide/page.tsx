import type { Metadata } from "next";
import Link from "next/link";
import { CopyButton } from "../demo-controls";
import Icon from "../components/Icon";
import PageHeading from "../components/PageHeading";

export const metadata: Metadata = {
  title: "Hướng dẫn | IntraCampus L1",
  description: "Cài mạng IntraCampus L1 trong ví và bắt đầu sử dụng các dịch vụ campus.",
};

const networkFields = [
  { id: "name", label: "Tên mạng · Network name", value: "IntraCampus L1", copyLabel: "Sao chép tên mạng" },
  { id: "rpc", label: "Network RPC URL", value: "https://float-itself-casino-files.trycloudflare.com/rpc", copyLabel: "Sao chép RPC URL" },
  { id: "chain", label: "Chain ID", value: "20261120", copyLabel: "Sao chép Chain ID" },
  { id: "symbol", label: "Token symbol", value: "CAMPUS", copyLabel: "Sao chép ký hiệu CAMPUS" },
  { id: "token", label: "Token name", value: "CAMPUS token", copyLabel: "Sao chép tên token" },
] as const;

const setupSteps = [
  { number: "01", title: "Mở phần cài đặt mạng", description: "Trong Core Wallet, mở Settings → Networks → Add network." },
  { number: "02", title: "Nhập thông tin mạng", description: "Điền năm trường ở trên. Để trống Explorer URL và Logo URL như trong ảnh." },
  { number: "03", title: "Lưu và chọn mạng", description: "Bấm Save, sau đó chuyển ví sang IntraCampus L1 · Chain 20261120." },
] as const;

export default function GuidePage() {
  return (
    <div className="campus-guide">
      <PageHeading
        eyebrow="HƯỚNG DẪN SỬ DỤNG"
        title="Kết nối IntraCampus L1"
        description="Thêm mạng demo Chain 20261120 vào ví, sau đó đăng nhập và dùng các dịch vụ campus."
        icon="book"
      />

      <section className="surface-panel guide-network-panel" aria-labelledby="guide-network-title">
        <div className="guide-section-head">
          <div>
            <span className="panel-eyebrow">01 · THIẾT LẬP VÍ</span>
            <h2 id="guide-network-title">Thêm mạng trên Core Wallet</h2>
            <p>Nhập đúng các giá trị dưới đây. Chọn một nút để sao chép từng trường.</p>
          </div>
          <span className="guide-chain-badge"><Icon name="grid" />Chain 20261120</span>
        </div>

        <dl className="guide-network-fields">
          {networkFields.map((field) => (
            <div className={`guide-network-field guide-field-${field.id}`} key={field.id}>
              <div className="guide-field-copy">
                <dt>{field.label}</dt>
                <dd><code>{field.value}</code></dd>
              </div>
              <CopyButton value={field.value} label={field.copyLabel} className="guide-copy-btn" />
            </div>
          ))}
        </dl>

        <p className="guide-optional-fields"><Icon name="check" />Để trống Explorer URL và Logo URL.</p>

        <ol className="guide-setup-steps" aria-label="Các bước thêm mạng">
          {setupSteps.map((step) => (
            <li key={step.number}>
              <span className="guide-step-number">{step.number}</span>
              <div><h3>{step.title}</h3><p>{step.description}</p></div>
            </li>
          ))}
        </ol>

        <p className="guide-rpc-note"><Icon name="shield" /><span>Đây là RPC demo của nhóm. Nếu ví báo không kết nối được, hãy xin nhóm URL RPC mới nhất.</span></p>
      </section>

      <section className="guide-usage-section" aria-labelledby="guide-usage-title">
        <div className="guide-usage-heading">
          <div><span className="panel-eyebrow">02 · SỬ DỤNG CƠ BẢN</span><h2 id="guide-usage-title">Ba luồng bắt đầu</h2></div>
          <p>Core Wallet sẽ hỏi xác nhận trước khi ký hoặc gửi giao dịch.</p>
        </div>
        <div className="guide-usage-grid">
          <article className="guide-usage-card">
            <span className="guide-usage-step">01 · TÀI KHOẢN</span>
            <h3>Đăng nhập bằng ví</h3>
            <p>Mở trang đăng nhập, kết nối Core hoặc MetaMask rồi ký thông điệp. Chữ ký chỉ xác nhận quyền sở hữu ví, không chuyển tiền và không tốn gas.</p>
            <Link className="button-primary" href="/login">Đăng nhập bằng ví<Icon name="arrow" /></Link>
          </article>
          <article className="guide-usage-card">
            <span className="guide-usage-step">02 · SINH VIÊN</span>
            <h3>Thanh toán hóa đơn QR</h3>
            <p>Mở ví sinh viên, quét hoặc dán QR từ điểm thu, kiểm tra hóa đơn và số tiền rồi xác nhận trên Core; chờ hệ thống xác minh biên nhận. Nhà ăn và Thư viện mở từ thanh điều hướng.</p>
            <Link className="button-primary" href="/student">Mở ví sinh viên<Icon name="arrow" /></Link>
          </article>
          <article className="guide-usage-card">
            <span className="guide-usage-step">03 · ĐIỂM THU</span>
            <h3>Tạo QR thanh toán</h3>
            <p>Mở POS thật, tạo hóa đơn và đưa QR cho sinh viên quét. Chỉ biên nhận đã xác minh mới được tính là thanh toán thành công.</p>
            <Link className="button-primary" href="/pos">Mở điểm thu<Icon name="arrow" /></Link>
          </article>
        </div>
        <p className="guide-demo-note"><Icon name="check" />Các màn hình “Bản minh họa” chỉ dùng dữ liệu mẫu, không tạo giao dịch trên mạng.</p>
      </section>
    </div>
  );
}
