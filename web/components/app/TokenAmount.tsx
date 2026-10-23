"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/cn";
import { formatTokenAmount, formatTokenExact } from "@/lib/format";

/**
 * One shared, overflow-proof way to render a token/ETH quantity anywhere in the
 * app. Shows the compact value (e.g. "103.41M") with the symbol kept on the same
 * line as its number (nowrap unit span, so the ticker never drops to its own
 * line). Tap / long-press / hover reveals the full exact value in a small
 * popover. DISPLAY ONLY — any "Max" button or math must use the raw bigint, not
 * this component.
 *
 * Pass `value` as a bigint scaled by `decimals` (default 18) for exactness, or a
 * plain number when a bigint isn't available (the reveal then just restates it).
 */
export function TokenAmount({
  value,
  decimals = 18,
  symbol,
  className,
  title,
}: {
  value: bigint | number;
  decimals?: number;
  symbol?: string;
  /** Extra classes for the trigger (e.g. text size / colour). */
  className?: string;
  /** Overrides the native hover tooltip text (defaults to the exact value). */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const compact = formatTokenAmount(value, { decimals });
  const exact = typeof value === "bigint" ? formatTokenExact(value, decimals) : String(value);
  const full = symbol ? `${exact} ${symbol}` : exact;
  // Only the reveal is worthwhile when the compact string already is the exact
  // value (short numbers) — but keeping it uniform avoids per-call-site logic.
  return (
    <span className="relative inline-flex min-w-0 max-w-full align-bottom">
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        title={title ?? full}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        className={cn(
          "min-w-0 max-w-full truncate whitespace-nowrap text-left tabular-nums",
          className,
        )}
      >
        {compact}
        {symbol ? <span className="whitespace-nowrap">&nbsp;{symbol}</span> : null}
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          className="absolute bottom-full left-0 z-30 mb-1 max-w-[min(18rem,80vw)] break-words rounded-input border border-border bg-surface-raised px-2 py-1 text-left text-xs font-normal normal-case tracking-normal text-text-primary shadow-lg"
        >
          {full}
        </span>
      ) : null}
    </span>
  );
}
