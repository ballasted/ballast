"use client";

import { useRef } from "react";
import { AssetDisc } from "@/components/app/AssetDisc";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { cn } from "@/lib/cn";

// Shared shell behind every "pick a pairing" surface in the redesign: the
// create flow's pool-pairing and treasury pickers, and the landing/Discover
// "pairs" strips. Purely presentational — no wagmi, no data-fetching — so
// it's safe to import from the marketing tree too (CLAUDE.md: wallet
// providers wrap only /app, never the root layout).

export type PairingItem = {
  key: string;
  symbol: string;
  isGreen: boolean;
  hasEthRoute?: boolean;
};

/** Horizontal, swipeable (CSS scroll-snap) row with desktop arrow buttons. */
export function HorizontalScroller({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  function scroll(dir: 1 | -1) {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: reduced ? "auto" : "smooth" });
  }

  return (
    <div className="relative min-w-0">
      <div
        ref={ref}
        className={cn(
          "flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-1 pb-1",
          "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          className,
        )}
      >
        {children}
      </div>
      <button
        type="button"
        aria-label="Scroll left"
        onClick={() => scroll(-1)}
        className="absolute -left-3 top-1/2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card text-text-secondary transition-colors hover:border-text-faint hover:text-text-primary md:flex"
      >
        ‹
      </button>
      <button
        type="button"
        aria-label="Scroll right"
        onClick={() => scroll(1)}
        className="absolute -right-3 top-1/2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card text-text-secondary transition-colors hover:border-text-faint hover:text-text-primary md:flex"
      >
        ›
      </button>
    </div>
  );
}

function PairingCard({
  item,
  size,
  selectable,
  selected,
  disabled,
  onClick,
}: {
  item: PairingItem;
  size: "md" | "lg";
  selectable?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  // Non-GREEN candidates are ALWAYS inert — in both display and selectable
  // mode — never clickable, never a transaction trigger.
  const clickable = Boolean(selectable && item.isGreen && !disabled);
  const dim = !item.isGreen || (Boolean(selectable) && Boolean(disabled) && !selected);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={clickable ? onClick : undefined}
      aria-pressed={selectable ? Boolean(selected) : undefined}
      title={!item.isGreen ? `${item.symbol} — coming soon` : item.symbol}
      className={cn(
        "flex shrink-0 snap-start flex-col items-center gap-2 rounded-card border p-3 text-center transition-colors",
        size === "lg" ? "w-[116px] py-4" : "w-[92px] py-3",
        selected
          ? "border-green bg-green-bg shadow-[0_0_0_1px_rgba(34,201,58,0.45),0_0_18px_-2px_rgba(34,201,58,0.55)]"
          : "border-border",
        dim && "opacity-40",
        clickable && !selected && "cursor-pointer hover:border-text-faint",
        !clickable && "cursor-default",
      )}
    >
      <AssetDisc identity={{ status: "recognized", symbol: item.symbol }} size={size === "lg" ? 48 : 36} />
      <span className="text-sm font-medium text-text-primary">{item.symbol}</span>
      {item.hasEthRoute ? (
        <span className="text-[10px] font-semibold uppercase tracking-wide text-green">ETH route</span>
      ) : !item.isGreen ? (
        <span className="text-[10px] uppercase tracking-wide text-text-faint">Coming soon</span>
      ) : (
        <span className="h-[13px]" aria-hidden />
      )}
    </button>
  );
}

/**
 * The shared pairing picker: WETH + every stock/RWA candidate as logo cards
 * in a horizontal scroller. `selectable` (create flow) makes GREEN cards
 * toggle membership in `selectedKeys`; omit it (landing/Discover strips) for
 * a pure, non-interactive display.
 */
export function PairingScroller({
  items,
  selectable = false,
  selectedKeys,
  onToggle,
  atCap,
  size = "md",
}: {
  items: PairingItem[];
  selectable?: boolean;
  selectedKeys?: Set<string>;
  onToggle?: (key: string) => void;
  atCap?: boolean;
  size?: "md" | "lg";
}) {
  return (
    <HorizontalScroller>
      {items.map((it) => (
        <PairingCard
          key={it.key}
          item={it}
          size={size}
          selectable={selectable}
          selected={selectedKeys?.has(it.key) ?? false}
          disabled={selectable && !(selectedKeys?.has(it.key) ?? false) && Boolean(atCap)}
          onClick={() => onToggle?.(it.key)}
        />
      ))}
    </HorizontalScroller>
  );
}

/**
 * Decorative, non-interactive logo marquee — WETH + every stock/RWA ticker
 * drifting past at a steady pace (reuses the existing `.ticker-track`
 * keyframe, same motion language as the discover ticker bar). Content is
 * rendered twice back-to-back so the loop is seamless. Under
 * prefers-reduced-motion this renders as a single static, wrapping row
 * instead (no motion, same content) — never removed, just stilled.
 */
export function LogoMarquee({ items }: { items: PairingItem[] }) {
  const reduced = useReducedMotion();
  const row = (
    <div className="flex shrink-0 items-center gap-8 pr-8">
      {items.map((it) => (
        <span key={it.key} className="flex flex-col items-center gap-1.5 opacity-80">
          <AssetDisc identity={{ status: "recognized", symbol: it.symbol }} size={32} />
          <span className="text-[10px] uppercase tracking-wide text-text-faint">{it.symbol}</span>
        </span>
      ))}
    </div>
  );

  if (reduced) {
    return (
      <div className="flex flex-wrap justify-center gap-8" aria-hidden>
        {row}
      </div>
    );
  }

  return (
    <div className="overflow-hidden" aria-hidden>
      <div className="ticker-track flex w-max">
        {row}
        {row}
      </div>
    </div>
  );
}
