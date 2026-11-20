import { notFound, redirect } from "next/navigation";
import { parkingCheckoutPath, parkingInvoiceId } from "../../../../../lib/parking";

export default async function CheckoutPage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  if (!parkingInvoiceId.test(invoiceId)) notFound();

  redirect(parkingCheckoutPath(invoiceId));
}
