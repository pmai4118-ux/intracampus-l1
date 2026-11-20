import Link from "next/link";
import Icon from "../../components/Icon";
import PageHeading from "../../components/PageHeading";
import ParkingGateScanner from "./ParkingGateScanner";

export default function ParkingGatePage() {
  return <>
    <PageHeading
      eyebrow="BÃI XE CAMPUS · CỔNG RA"
      title="Cổng ra bãi xe"
      description="Quét mã QR từ Ví sinh viên để đối chiếu thanh toán và xác nhận lượt ra."
      icon="qr"
    >
      <div className="parking-page-actions">
        <span className="page-context-tag">
          <Icon name="qr" />
          Cổng ra · Quét vé
        </span>
        <Link className="secondary-btn" href="/pos">
          ← Điểm thu POS
        </Link>
      </div>
    </PageHeading>
    <ParkingGateScanner />
  </>;
}
