"use client";

import Link from "next/link";
import { useLiveRail, type LiveRailStatus } from "@/hooks/useLiveRail";
import type { Project } from "@/hooks/useProjects";
import type { RailEvent } from "@/lib/liveRail";
import { useNow } from "@/hooks/useNow";
import { shortAddress } from "@/lib/format";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";

const LABEL: Record<RailEvent["kind"], { text: string; className: string }> = {
  LAUNCH: { text: "LAUNCH", className: "text-green" },
  GRADUATED: { text: "GRADUATED", className: "text-green" },
  BURN: { text: "BURN", className: "text-negative" },
  BUY: { text: "BUY", className: "text-green" },
};

// Live protocol feed (spec §5.6). Reserve-state changes are dropped — see
// hooks/useLiveRail.ts. The status line is load-bearing, not decoration: a
// failed backfill must say "live from now", never imply history it doesn't
// have.
export function LiveRail({ projects }: { projects: Project[] }) {
  const { events, status } = useLiveRail(projects);
  const now = useNow();

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <h2 className="section-label">Live feed</h2>
        <StatusChip status={status} />
      </div>

      {status === "loading" ? (
        <SkeletonRows />
      ) : events.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          Nothing yet. Launches, graduations, burns, and large buys will appear here as they happen.
        </p>
      ) : (
        <ul className="mt-3 space-y-2" aria-live="polite">
          {events.map((e) => (
            <li key={e.key}>
              <RailRow event={e} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: LiveRailStatus }) {
  if (status === "loading") return null;
  if (status === "ready") return <span className="eyebrow">Live</span>;
  if (status === "partial") return <span className="chip chip-warning">Partial history</span>;
  return <span className="chip chip-warning" title="The ~24h backfill couldn't be read — showing new activity only">Live from now</span>;
}

function RailRow({ event, now }: { event: RailEvent; now: number }) {
  const label = LABEL[event.kind];
  return (
    <Link
      href={event.token ? `/app/token/${event.token}` : `#`}
      className={cn(
        "flex items-center justify-between gap-2 rounded-input px-2 py-1.5 text-sm transition-colors",
        event.token ? "hover:bg-surface-raised" : "pointer-events-none",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("shrink-0 font-mono text-[11px] font-semibold", label.className)}>{label.text}</span>
        <span className="truncate text-text-secondary">{describe(event)}</span>
      </span>
      <span className="shrink-0 text-xs text-text-faint">
        {event.timestamp !== undefined ? timeAgo(event.timestamp, now) : ""}
      </span>
    </Link>
  );
}

function describe(e: RailEvent): string {
  const who = e.symbol ?? (e.token ? shortAddress(e.token) : "—");
  switch (e.kind) {
    case "LAUNCH":
      return `${who} launched`;
    case "GRADUATED":
      return `${who} graduated`;
    case "BURN":
      return e.amountUsd !== undefined ? `$${e.amountUsd.toLocaleString("en", { maximumFractionDigits: 0 })} bought back & burned` : "Buyback & burn";
    case "BUY":
      return e.amountUsd !== undefined
        ? `${who} · $${e.amountUsd.toLocaleString("en", { maximumFractionDigits: 0 })} buy`
        : `${who} buy`;
  }
}

function SkeletonRows() {
  return (
    <div className="mt-3 space-y-2" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-6 animate-pulse rounded bg-surface-raised" />
      ))}
    </div>
  );
}
