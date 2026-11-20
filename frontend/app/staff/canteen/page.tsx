import type { Metadata } from 'next';
import CanteenStaffSession from './CanteenStaffSession';

export const metadata: Metadata = {
  title: 'Quầy Bếp Nhà Ăn · IntraCampus L1',
  description: 'Màn hình phục vụ đơn giản cho các cô nhà ăn: nhận phiếu đã thu tiền, giao khay 1 chạm và bật/tắt món.',
};

export default function CanteenStaffPage() {
  return <CanteenStaffSession />;
}
