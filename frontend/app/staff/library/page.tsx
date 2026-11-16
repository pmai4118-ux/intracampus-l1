import type { Metadata } from 'next';
import LibraryStaffSession from './LibraryStaffSession';
export const metadata: Metadata = { title: 'Thủ thư | IntraCampus L1', description: 'Duyệt mượn và xử lý sách trả.' };
export default function StaffLibraryPage() { return <LibraryStaffSession />; }
