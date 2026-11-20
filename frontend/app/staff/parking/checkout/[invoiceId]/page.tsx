import { notFound } from "next/navigation";
import { parkingInvoiceId } from "../../../../../lib/parking";
import PageHeading from "../../../../components/PageHeading";
import { WalletSession } from "../../../../student/WalletPanel";
import ParkingGateCheckout from "./ParkingGateCheckout";

export default async function CheckoutPage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  if (!parkingInvoiceId.test(invoiceId)) notFound();

  return <>
    <PageHeading eyebrow="BÃI XE CAMPUS" title="Xác nhận ở cổng ra" description="Đối chiếu vé sinh viên xuất trình trước khi cho xe ra." icon="store" />
    <WalletSession>
      <ParkingGateCheckout key={invoiceId} invoiceId={invoiceId} />
    </WalletSession>
  </>;
}
