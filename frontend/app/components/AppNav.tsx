"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon, { type IconName } from "./Icon";

const links: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Tổng quan", icon: "grid" },
  { href: "/student", label: "Sinh viên", icon: "wallet" },
  { href: "/student/canteen", label: "Nhà ăn", icon: "utensils" },
  { href: "/student/library", label: "Thư viện", icon: "book" },
  { href: "/pos", label: "Điểm thu", icon: "store" },
  { href: "/staff/canteen", label: "Quầy bếp", icon: "bowl" },
  { href: "/staff/library", label: "Thủ thư", icon: "shield" },
];

export default function AppNav() {
  const pathname = usePathname();
  return <header className="app-header">
    <div className="app-topbar">
      <Link href="/" className="brand" aria-label="IntraCampus L1 — Trang chủ">
        <span className="brand-symbol"><Icon name="graduation" /></span>
        <span>IntraCampus<span className="brand-l1">L1</span></span>
      </Link>
      <span className="app-tagline">Kết nối nhịp sống campus</span>
      <span className="environment-badge"><span />UniHack 2026 · Demo</span>
    </div>
    <nav className="app-nav" aria-label="Điều hướng chính">
      {links.map(({ href, label, icon }) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
        <Icon name={icon} /><span>{label}</span>
      </Link>)}
      <span className="nav-network">Avalanche L1 · Chain 20261</span>
    </nav>
  </header>;
}
