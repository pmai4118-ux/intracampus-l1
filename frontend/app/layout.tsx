import type { Metadata } from "next";
import type { ReactNode } from "react";
import AppNav from "./components/AppNav";
import Icon from "./components/Icon";
import "./styles.css";
import "./campus.css";

export const metadata: Metadata = {
  title: "IntraCampus L1",
  description:
    "Nền tảng thử nghiệm thanh toán và định danh trong khuôn viên trường.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#main-content">
          Bỏ qua điều hướng
        </a>
        <AppNav />
        <main id="main-content">{children}</main>
        <footer className="app-footer"><span><Icon name="graduation" />IntraCampus L1 <span className="footer-divider">/</span> Một kết nối, nhiều trải nghiệm.</span>
          <span>Built on Avalanche <span className="avalanche-mark" aria-hidden="true">▲</span></span></footer>
      </body>
    </html>
  );
}
