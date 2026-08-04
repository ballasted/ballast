"use client";

import { useNow } from "@/hooks/useNow";
import { cn } from "@/lib/cn";

// Reusable freshness indicator (spec 1.2/1.3): a small dot + a relative timestamp
// reading "Live", "delayed Xm ago", or "unavailable" — so a figure is never shown
// with no indication of when it was true. Static (no pulse — spec 4.4). Built here
// in Part 1 for correct behaviour; placed across the figures during the Part 4 UI
// rebuild rather than styled twice.

function rel(sec: number): string {
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export function Freshness({
  updatedAt,
  liveWithin = 30,
  unavailable,
  source,
  className,
}: {
  updatedAt?: number; // unix seconds when the data was last known-good
  liveWithin?: number; // age (s) within which the figure reads "Live"
  unavailable?: boolean; // force the unavailable state (source unreachable)
  source?: string; // optional source name to show, e.g. "GeckoTerminal"
  className?: string;
}) {
  const now = useNow(); // unix seconds; 0 until mounted
  const dead = unavailable || updatedAt === undefined || updatedAt <= 0;
  const age = !dead && now > 0 ? Math.max(0, now - updatedAt) : 0;
  const live = !dead && age <= liveWithin;

  const tone = dead ? "bg-text-faint" : live ? "bg-green" : "bg-warning";
  const text = dead ? "unavailable" : live ? "Live" : `delayed ${rel(age)}`;

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs text-text-faint", className)}
      title={source ? `Source: ${source}` : undefined}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)} aria-hidden />
      <span>
        {text}
        {source ? ` · ${source}` : ""}
      </span>
    </span>
  );
}
