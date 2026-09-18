"use client";

import { cn } from "@/lib/cn";

// Only sorts computable from a real source (Phase 5): on-chain order or the
// same GeckoTerminal read the volume figure elsewhere on the page already
// uses. No ATH, no Last Trade — a sort that silently falls back to another
// order is worse than an absent one.
export type SortId = "mcap" | "newest" | "volume" | "backing";
export type FilterId = "all" | "ballasted" | "graduated" | "curve";

const SORTS: { id: SortId; label: string }[] = [
  { id: "mcap", label: "Market cap" },
  { id: "newest", label: "Newest" },
  { id: "volume", label: "24h volume" },
  { id: "backing", label: "Backing" },
];

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ballasted", label: "Ballasted" },
  { id: "graduated", label: "Graduated" },
  { id: "curve", label: "On curve" },
];

// One row, plain text — not pills, no horizontal scroll. Sort on the left,
// filter on the right of a hairline divider.
export function SortRail({
  sort,
  onSort,
  filter,
  onFilter,
}: {
  sort: SortId;
  onSort: (s: SortId) => void;
  filter: FilterId;
  onFilter: (f: FilterId) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      {SORTS.map((s) => (
        <button
          key={s.id}
          onClick={() => onSort(s.id)}
          aria-pressed={sort === s.id}
          className={cn(
            "transition-colors",
            sort === s.id ? "font-semibold text-text-primary" : "text-text-muted hover:text-text-secondary",
          )}
        >
          {s.label}
        </button>
      ))}
      <span className="hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
      {FILTERS.map((f) => (
        <button
          key={f.id}
          onClick={() => onFilter(f.id)}
          aria-pressed={filter === f.id}
          className={cn(
            "transition-colors",
            filter === f.id ? "font-semibold text-green" : "text-text-muted hover:text-text-secondary",
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}
