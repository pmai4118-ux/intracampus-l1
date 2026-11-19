import type { SVGProps } from "react";

const paths = {
  arrow: "M5 12h14m-6-6 6 6-6 6",
  wallet: "M20 8V5a1 1 0 0 0-1-1H5a3 3 0 0 0 0 6h15v10H5a3 3 0 0 1-3-3V7m18 6h-5v4h5m-3-2h.01",
  book: "M12 5v15M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Z",
  qr: "M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM21 14v3m-6 4h3m3-1v1m-3-10v1M3 12h3m6-9v3m0 9v3",
  shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Zm-4 9 3 3 5-6",
  graduation: "m2 9 10-5 10 5-10 5L2 9Zm4 2v6c4 3 8 3 12 0v-6m4-2v7",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  store: "M3 10v10h18V10M2 10l2-7h16l2 7M2 10c0 4 5 4 5 0 0 4 5 4 5 0 0 4 5 4 5 0 0 4 5 4 5 0M9 20v-6h6v6",
  sparkle: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z",
  check: "m5 12 4 4L19 6",
  clock: "M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  chevron: "m9 5 7 7-7 7",
  leaf: "M5 19C-2 6 11 3 21 3c0 10-3 23-16 16Zm0 0L16 8",
  utensils: "M4 3v6c0 3 6 3 6 0V3M7 3v18M17 3c-3 3-3 8 0 9h3M20 3v18",
  bowl: "M3 12h18c0 10-18 10-18 0ZM6 21h12M7 8c-3-3 3-3 0-6m5 6c-3-3 3-3 0-6m5 6c-3-3 3-3 0-6",
  copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
} as const;

export type IconName = keyof typeof paths;
export default function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}
