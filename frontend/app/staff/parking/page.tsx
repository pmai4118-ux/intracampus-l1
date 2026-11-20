import PageHeading from "../../components/PageHeading";
import ParkingGateScanner from "./ParkingGateScanner";

export default function ParkingGatePage() {
  return <>
    <PageHeading eyebrow="BÃI XE CAMPUS" title="Cổng ra bãi xe" description="Mở vé bằng mã QR trong Ví sinh viên." icon="qr" />
    <ParkingGateScanner />
  </>;
}
