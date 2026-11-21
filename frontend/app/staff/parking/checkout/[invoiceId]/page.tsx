import Link from "next/link";
import { notFound } from "next/navigation";
import { getDeployment, requireDeployment } from "@intracampus/network";
import { parkingInvoiceId } from "../../../../../lib/parking";
import { isWalletAddress } from "../../../../../lib/chains";
import Icon from "../../../../components/Icon";
import PageHeading from "../../../../components/PageHeading";
import { WalletSession } from "../../../../student/WalletPanel";
import ParkingGateCheckout from "./ParkingGateCheckout";

export default async function CheckoutPage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  if (!parkingInvoiceId.test(invoiceId)) notFound();
  const deployment = getDeployment();
  const parkingWallet = deployment.status === "deployed"
    ? requireDeployment(deployment).merchants.parking.address
    : process.env.PARKING_MERCHANT_ADDRESS?.trim();

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
      <ParkingGateCheckout key={invoiceId} invoiceId={invoiceId}
        parkingWallet={isWalletAddress(parkingWallet) ? parkingWallet : undefined} />
    </WalletSession>
  </>;
}
