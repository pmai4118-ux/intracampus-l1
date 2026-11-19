import type { LibraryBook } from "@intracampus/network";

type CoverTheme = {
  key: "moss" | "sapphire" | "ochre" | "indigo" | "teal" | "terracotta";
  code: string;
};

const FALLBACK_THEMES: CoverTheme[] = [
  { key: "moss", code: "L1" },
  { key: "sapphire", code: "SEC" },
  { key: "indigo", code: "ALG" },
  { key: "teal", code: "SYS" },
  { key: "ochre", code: "AI" },
  { key: "terracotta", code: "ECO" },
];

function resolveCoverTheme(book: Pick<LibraryBook, "title" | "isbn" | "bookId">): CoverTheme {
  const text = `${book.title} ${book.isbn ?? ""}`.toLowerCase();
  if (/chuỗi khối|avalanche|blockchain|solidity|foundry|hợp đồng thông minh/.test(text)) {
    return { key: "moss", code: /solidity|hợp đồng/.test(text) ? "SOL" : "L1" };
  }
  if (/mật mã|eip-712|an toàn|bảo mật|kiểm thử/.test(text)) {
    return { key: "sapphire", code: /mật mã|eip/.test(text) ? "CRY" : "SEC" };
  }
  if (/trí tuệ nhân tạo|học sâu|dữ liệu|ai\b/.test(text) && !/cấu trúc dữ liệu/.test(text)) {
    return { key: "ochre", code: "AI" };
  }
  if (/cấu trúc dữ liệu|giải thuật/.test(text)) {
    return { key: "indigo", code: "ALG" };
  }
  if (/phân tán|đồng thuận|mạng/.test(text)) {
    return { key: "teal", code: "SYS" };
  }
  if (/kinh tế|token|khuyến khích/.test(text)) {
    return { key: "terracotta", code: "ECO" };
  }
  const seed = book.isbn ?? book.bookId ?? book.title;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_THEMES[hash % FALLBACK_THEMES.length];
}

function CoverMotif({ themeKey }: { themeKey: CoverTheme["key"] }) {
  switch (themeKey) {
    case "moss":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="4" width="6.5" height="6.5" rx="1.4" />
          <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" />
          <path d="M10.5 7.25h3.25a3 3 0 0 1 3 3v3.25M7.25 10.5v3.25a3 3 0 0 0 3 3h3.25" />
        </svg>
      );
    case "sapphire":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3.5 5 6.8v5c0 4.5 7 8.2 7 8.2s7-3.7 7-8.2v-5L12 3.5Z" />
          <circle cx="12" cy="11" r="1.8" />
          <path d="M12 12.8v2.7" />
        </svg>
      );
    case "ochre":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="6" cy="7" r="2" />
          <circle cx="6" cy="17" r="2" />
          <circle cx="18" cy="12" r="2.2" />
          <path d="M7.8 8 16 11.2M7.8 16 16 12.8M6 9v6" />
        </svg>
      );
    case "indigo":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="5.5" r="2.1" />
          <circle cx="6.5" cy="17.5" r="2.1" />
          <circle cx="17.5" cy="17.5" r="2.1" />
          <path d="M10.8 7.3 7.5 15.6M13.2 7.3l3.3 8.3" />
        </svg>
      );
    case "teal":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="7.5" />
          <ellipse cx="12" cy="12" rx="3.3" ry="7.5" />
          <path d="M4.8 12h14.4" />
        </svg>
      );
    case "terracotta":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="7.2" />
          <path d="M9.5 9.8c0-1.1 1.1-1.9 2.5-1.9s2.5.8 2.5 1.9-1 1.7-2.5 2.1-2.5 1-2.5 2.2 1.1 2 2.5 2 2.5-.8 2.5-1.9M12 6.5v11" />
        </svg>
      );
  }
}

export default function BookCover({
  book,
  size = "md",
}: {
  book: Pick<LibraryBook, "title" | "isbn" | "bookId">;
  size?: "sm" | "md";
}) {
  const theme = resolveCoverTheme(book);
  const digits = (book.isbn ?? "").replace(/\D/g, "");
  const suffix = digits.length >= 3 ? digits.slice(-3) : book.bookId.slice(-3).toUpperCase();

  return (
    <div
      className={`book-cover book-cover-${theme.key} ${size === "sm" ? "book-cover-sm" : ""}`}
      aria-hidden="true"
    >
      <span className="book-cover-spine" />
      <div className="book-cover-face">
        <span className="book-cover-tag">{theme.code}</span>
        <span className="book-cover-motif">
          <CoverMotif themeKey={theme.key} />
        </span>
        <span className="book-cover-code tabular-nums">{suffix}</span>
      </div>
    </div>
  );
}
