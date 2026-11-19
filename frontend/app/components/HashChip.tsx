"use client";

import { useEffect, useState } from "react";
import Icon from "./Icon";

export default function HashChip({
  value,
  start = 6,
  end = 4,
  copyLabel = "Sao chép mã",
  expandable = true,
}: {
  value: string;
  start?: number;
  end?: number;
  copyLabel?: string;
  expandable?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const canShorten = value.length > start + end + 3;
  const display = expanded || !canShorten ? value : `${value.slice(0, start)}…${value.slice(-end)}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setExpanded(true);
    }
  }

  return (
    <span className={`hash-chip ${copied ? "hash-chip-copied" : ""}`} title={value}>
      <code className="mono-value hash-chip-code" translate="no">
        {display}
      </code>
      <button
        type="button"
        className={`hash-chip-btn hash-copy-icon-btn ${copied ? "is-copied" : ""}`}
        aria-label={`${copyLabel}: ${value}`}
        title={copied ? "Đã chép" : copyLabel}
        onClick={() => void handleCopy()}
      >
        <Icon name={copied ? "check" : "copy"} />
        {copied ? <span>Đã chép</span> : null}
      </button>
      {expandable && canShorten ? (
        <button
          type="button"
          className="hash-chip-btn hash-expand-btn"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "Thu gọn" : "Đầy đủ"}
        </button>
      ) : null}
    </span>
  );
}
