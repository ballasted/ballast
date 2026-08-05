"use client";

import { cn } from "@/lib/cn";

// Only sorts we can actually compute from a real source (Phase 5). No ATH, no Last
// Trade — we have no reliable source, and a sort that silently falls back to another
// order is worse than an absent one. Trending is deliberately NOT here (it needs
// unique-buyer data and keeps its own honest state); it's a separate control.
export type SortId = "ballasted" | "newest" | "oldest" | "mcap" | "ratio" | "volume" | "holders";
export type SortSource = "on-chain" | "GeckoTerminal" | "Blockscout";

export const SORTS: { id: SortId; label: string; rule: string; source: SortSource }[] = [
  { id: "ballasted", label: "Ballasted", rule: "Ballasted first, then locked backing, descending", source: "on-chain" },
  { id: "newest", label: "Newest", rule: "Most recent launch first", source: "on-chain" },
  { id: "oldest", label: "Oldest", rule: "Earliest launch first", source: "on-chain" },
  { id: "mcap", label: "Market cap", rule: "Market cap (live price × supply), descending", source: "on-chain" },
  { id: "ratio", label: "Backing ratio", rule: "Market cap ÷ treasury value, descending", source: "on-chain" },
  { id: "volume", label: "24h volume", rule: "24h traded volume, descending", source: "GeckoTerminal" },
  { id: "holders", label: "Holders", rule: "Unique holders, descending", source: "Blockscout" },
];

export function SortRail({
  sort,
  onSort,
  trending,
  onTrending,
}: {
  sort: SortId;
  onSort: (s: SortId) => void;
  trending: boolean;
  onTrending: (v: boolean) => void;
}) {
  const current = SORTS.find((s) => s.id === sort);
  return (
    <div>
      <div className="flex items-center gap-2">
        {/* The sort chip rail — scrolls horizontally on small screens. */}
        <div className="-mx-1 flex flex-1 gap-2 overflow-x-auto px-1 pb-1">
          {SORTS.map((s) => {
            const active = !trending && sort === s.id;
            return (
              <button
                key={s.id}
                onClick={() => onSort(s.id)}
                aria-pressed={active}
                className={cn("tab shrink-0", active ? "tab-active" : "tab-idle")}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {/* Trending — set apart from the rail (dashed, divider) because it is its own
            state, not a computed sort. */}
        <div className="flex shrink-0 items-center gap-2 border-l border-border pl-2">
          <button
            onClick={() => onTrending(!trending)}
            aria-pressed={trending}
            className={cn(
              "tab shrink-0 border-dashed",
              trending ? "border-green text-green" : "border-border-strong text-text-muted hover:text-text-secondary",
            )}
          >
            Trending
          </button>
        </div>
      </div>

      {/* Rule line — a ranking whose rule isn't stated is an editorial decision
          pretending to be a measurement. */}
      <p className="mt-2 text-xs text-text-faint">
        {trending
          ? "Ranked by unique buyers, then 24h volume · GeckoTerminal"
          : current
            ? `${current.rule} · ${current.source}`
            : ""}
      </p>
    </div>
  );
}
