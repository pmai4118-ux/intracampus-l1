"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import Icon, { type IconName } from "./Icon";

type NavLink = { href: string; label: string; icon: IconName };
const studentLinks: NavLink[] = [
  { href: "/", label: "Tổng quan", icon: "grid" },
  { href: "/student", label: "Sinh viên", icon: "wallet" },
  { href: "/student/canteen", label: "Nhà ăn", icon: "utensils" },
  { href: "/student/library", label: "Thư viện", icon: "book" },
];
const providerLinks: NavLink[] = [
  { href: "/pos", label: "Điểm thu", icon: "store" },
  { href: "/staff/parking", label: "Cổng ra", icon: "qr" },
  { href: "/staff/canteen", label: "Quầy bếp", icon: "bowl" },
  { href: "/staff/library", label: "Thủ thư", icon: "shield" },
];

export default function AppNav() {
  const pathname = usePathname();
  const header = useRef<HTMLElement>(null);
  const provider = pathname === "/pos" || pathname.startsWith("/staff/");
  const links = provider ? providerLinks : studentLinks;
  const home = provider ? "/pos" : "/";

  useEffect(() => {
    const element = header.current;
    if (!element) return;
    element.removeAttribute("data-scroll-hidden");
    let previous = Math.max(0, window.scrollY);
    let distance = 0;
    let frame: number | null = null;
    const followScroll = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const position = Math.max(0, window.scrollY);
        const delta = position - previous;
        previous = position;
        if (delta) distance = Math.sign(delta) === Math.sign(distance) ? distance + delta : delta;
        if (position <= element.offsetHeight || distance <= -8) {
          element.removeAttribute("data-scroll-hidden");
        } else if (distance >= 8) {
          element.setAttribute("data-scroll-hidden", "");
        }
      });
    };
    window.addEventListener("scroll", followScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", followScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  return <header ref={header} className="app-header">
    <div className="app-topbar">
      <Link href={home} className="brand" aria-label={provider ? "IntraCampus L1 — Điểm thu" : "IntraCampus L1 — Trang chủ sinh viên"}>
        <span className="brand-symbol"><Icon name="graduation" /></span>
        <span>IntraCampus<span className="brand-l1">L1</span></span>
      </Link>
      <span className="app-tagline">{provider ? "Không gian cung cấp dịch vụ" : "Không gian sinh viên"}</span>
      <span className="environment-badge"><span />UniHack 2026 · Demo</span>
    </div>
    <nav className="app-nav" aria-label="Điều hướng chính">
      {links.map(({ href, label, icon }) => <Link key={href} href={href}
        aria-current={pathname === href ? "page" : href === "/staff/parking" && pathname.startsWith(`${href}/`) ? "location" : undefined}>
        <Icon name={icon} /><span>{label}</span>
      </Link>)}
      <span className="nav-network">Avalanche L1 · Chain 20261</span>
    </nav>
  </header>;
}
