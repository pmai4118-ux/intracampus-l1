import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./styles.css";

export const metadata: Metadata = {
  title: "IntraCampus L1",
  description: "Nền tảng thử nghiệm thanh toán và định danh trong khuôn viên trường.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <header>
          <nav aria-label="Điều hướng chính">
            <Link href="/" className="brand">IntraCampus L1</Link>
            <Link href="/student">Sinh viên</Link>
            <Link href="/pos">Điểm thu</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
