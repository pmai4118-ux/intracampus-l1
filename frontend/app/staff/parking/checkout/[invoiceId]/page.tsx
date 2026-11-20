import Link from "next/link";
import { notFound } from "next/navigation";
import { parkingInvoiceId } from "../../../../../lib/parking";
import Icon from "../../../../components/Icon";
import PageHeading from "../../../../components/PageHeading";
import { WalletSession } from "../../../../student/WalletPanel";
import ParkingGateCheckout from "./ParkingGateCheckout";

export default async function CheckoutPage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  if (!parkingInvoiceId.test(invoiceId)) notFound();

  return <>
    <PageHeading
      eyebrow="BÃI XE CAMPUS · XÁC NHẬN LƯỢT RA"
      title="Xác nhận ở cổng ra"
      description="Đối chiếu vé sinh viên xuất trình trước khi cho xe qua cổng."
      icon="store"
    >
      <div className="parking-page-actions">
        <Link className="secondary-btn" href="/staff/parking">
          <Icon name="qr" />
          Quét vé khác
        </Link>
        <Link className="secondary-btn" href="/pos">
          Điểm thu POS
        </Link>
      </div>
    </PageHeading>
    <WalletSession>
      <ParkingGateCheckout key={invoiceId} invoiceId={invoiceId} />
    </WalletSession>
  </>;
}
