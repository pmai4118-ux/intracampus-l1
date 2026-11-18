import type { Metadata } from 'next';
import CanteenSession from './CanteenSession';
export const metadata: Metadata = { title: 'Nhà ăn | IntraCampus L1', description: 'Đặt món và thanh toán bằng CAMPUS hoặc học bổng FOOD.' };
export default function Page() { return <CanteenSession />; }
