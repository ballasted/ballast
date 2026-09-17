"use client";

import { useEffect, useRef, useState } from "react";
import { useLiveRail } from "@/hooks/useLiveRail";
import { useProjects } from "@/hooks/useProjects";
import type { RailEvent } from "@/lib/liveRail";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

const MAX_VISIBLE = 3;
const DISMISS_MS = 6000;

type Toast = {
  id: string;
  tag: string;
  text: string;
  chipClass: string;
};

// Only these RailEvent kinds get a toast. BUY (large-trade) events exist in
// the same feed but are deliberately left out here — a running stream of
// "someone bought" notices reads as trading-app hype ("come buy this"),
// which sits too close to the CTA-style copy this product's legal posture
// rules out. Launches/graduations/burns are neutral activity notices; buys
// are optional upside framing this component doesn't need to add.
function toastFor(event: RailEvent): Toast | undefined {
  switch (event.kind) {
    case "LAUNCH": {
      const who = event.symbol ? `$${event.symbol}` : event.token ? shortAddress(event.token) : "A token";
      return { id: event.key, tag: "LAUNCH", text: `${who} launched`, chipClass: "chip-accent" };
    }
    case "GRADUATED": {
      // Graduation is the point BallastFactory records backingUsd and opens
      // the pool — the on-chain moment a launch becomes a backed, tradable
      // token. "Ballasted" here means treasury-funded, not any claim on it.
      const who = event.symbol ? `$${event.symbol}` : event.token ? shortAddress(event.token) : "A token";
      return { id: event.key, tag: "BALLASTED", text: `${who} is now ballasted`, chipClass: "chip-accent" };
    }
    case "BURN":
      // Buyback/burn events carry no per-token symbol in the feed (see
      // lib/liveRail.ts — BURN rows only ever get an amountUsd), so the copy
      // stays generic rather than guessing a ticker.
      return { id: event.key, tag: "BURN", text: "Buyback burn executed", chipClass: "chip-warning" };
    default:
      return undefined;
  }
}

/**
 * Top-center transient toast stack for genuine on-chain activity (launches,
 * graduations/"ballasted", buyback burns). Reuses the exact same feed as the
 * Discover page's LiveRail (useLiveRail, fed by useProjects) — no new API
 * route, no second poller. Each RailEvent's `key` (txHash-logIndex) is the
 * unique id used to detect "genuinely new since last render"; the feed's
 * initial backfill is recorded as already-seen on first observation so
 * history doesn't flood the stack on mount — only events that arrive after
 * that point ever toast.
 */
export function EventToasts() {
  const { projects } = useProjects();
  const { events } = useLiveRail(projects);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (seenRef.current === null) {
      seenRef.current = new Set(events.map((e) => e.key));
      return;
    }
    const seen = seenRef.current;
    const fresh: Toast[] = [];
    for (const e of events) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      const t = toastFor(e);
      if (t) fresh.push(t);
    }
    if (fresh.length === 0) return;

    setToasts((prev) => [...fresh, ...prev].slice(0, MAX_VISIBLE));
    fresh.forEach((t) => {
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, DISMISS_MS);
    });
  }, [events]);

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="anim-toast-in anim-toast-flash card-raised pointer-events-auto flex items-center gap-2 px-3 py-2 shadow-lg"
        >
          <span className={cn("chip", t.chipClass)}>{t.tag}</span>
          <span className="text-sm text-text-secondary">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
