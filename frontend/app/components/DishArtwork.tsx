type DishKind = "noodle" | "rice" | "baguette" | "tea" | "coffee" | "parfait" | "tray";

function resolveDishKind(id: string, name: string, category?: string): DishKind {
  const text = `${id} ${name}`.toLowerCase();
  if (/pho|phở|bun|bún|mi-|mì/.test(text)) return "noodle";
  if (/banh-mi|bánh mì/.test(text)) return "baguette";
  if (/ca-phe|cà phê/.test(text)) return "coffee";
  if (/sua-chua|sữa chua|chè|tráng miệng/.test(text)) return "parfait";
  if (/tra-|trà|cam|đào|nước/.test(text) || category === "snack-drink") return "tea";
  return "rice";
}

function DishGlyph({ kind }: { kind: DishKind }) {
  switch (kind) {
    case "noodle":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 12.5h16a8 8 0 0 1-16 0Z" />
          <path d="M8.5 20.5h7" />
          <path d="M7 9.5c0-1.6 1.2-2.2 1.2-3.6M11.5 9.5c0-1.6 1.2-2.2 1.2-3.6M15.5 6.2l4.5-1.7M14.5 8.8l5.5-1.3" />
        </svg>
      );
    case "rice":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <ellipse cx="12" cy="15.5" rx="8.5" ry="4" />
          <path d="M6.5 14.5a5.5 5.5 0 0 1 11 0" />
          <path d="M12 9c1.2-1.8 3.2-2.2 4.5-1.4-.4 1.6-1.9 2.5-4.5 1.4Z" />
        </svg>
      );
    case "baguette":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5.6 18.4c-1.8-1.8-1.4-5.1 1.6-8.1l3.1-3.1c3-3 6.3-3.4 8.1-1.6 1.8 1.8 1.4 5.1-1.6 8.1l-3.1 3.1c-3 3-6.3 3.4-8.1 1.6Z" />
          <path d="m9.2 11.2 2.2 2.2M12.2 8.2l2.2 2.2M6.8 14.2l1.9 1.9" />
        </svg>
      );
    case "tea":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7.5 8.5h9l-1 11a1.6 1.6 0 0 1-1.6 1.5h-3.8a1.6 1.6 0 0 1-1.6-1.5l-1-11Z" />
          <path d="M6.5 8.5h11M13 8.5l1.8-4.5h2" />
          <circle cx="15.8" cy="8.5" r="2.3" />
        </svg>
      );
    case "coffee":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5.5 9.5h10v5.5a5 5 0 0 1-10 0V9.5Z" />
          <path d="M15.5 11h1.8a2.2 2.2 0 0 1 0 4.4h-1.8M4.5 20h12" />
          <path d="M8.8 6.8c0-1.2.9-1.7.9-2.8M12.2 6.8c0-1.2.9-1.7.9-2.8" />
        </svg>
      );
    case "parfait":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6.5 10.5h11l-1.6 6.2a3.8 3.8 0 0 1-3.7 2.8h-.4a3.8 3.8 0 0 1-3.7-2.8l-1.6-6.2Z" />
          <path d="M8 10.5a4 4 0 0 1 8 0M14.5 7.2l2.3-3.2" />
          <circle cx="12" cy="6.8" r="1.3" />
        </svg>
      );
    case "tray":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 15.5h16M5.5 15.5a6.5 6.5 0 0 1 13 0M10.5 7h3M12 7v2" />
          <path d="M3 18.5h18" />
        </svg>
      );
  }
}

export default function DishArtwork({
  dishId,
  name,
  category,
  emptyTray = false,
}: {
  dishId?: string;
  name?: string;
  category?: string;
  emptyTray?: boolean;
}) {
  const kind: DishKind = emptyTray ? "tray" : resolveDishKind(dishId ?? "", name ?? "", category);
  return (
    <span className={`dish-artwork-tile dish-art-${kind}`} aria-hidden="true">
      <DishGlyph kind={kind} />
    </span>
  );
}
