import type { Metadata } from 'next';
import LibrarySession from './LibrarySession';
export const metadata: Metadata = { title: 'Thư viện sinh viên | IntraCampus L1', description: 'Tra cứu sách, quản lý yêu cầu mượn và tiền cọc CAMPUS.' };
export default function LibraryPage() { return <LibrarySession />; }
