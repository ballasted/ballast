"use client";

import type { Project } from "@/hooks/useProjects";
import { useLiveRail } from "@/hooks/useLiveRail";
import type { RailEvent } from "@/lib/liveRail";
import { shortAddress, timeAgo } from "@/lib/format";
import { useNow } from "@/hooks/useNow";
import { cn } from "@/lib/cn";

const MAX_ROWS = 5;

type NewsItem = { key: string; tag: string; text: string; chipClass: string; timestamp?: number };

// Same three event kinds and exact copy as EventToasts' toastFor() — this panel
// and the toast stack are both "activity notice" surfaces reading the same
// feed, so they should never describe the same event differently. BUY is left
// out here for the same reason it's left out of toasts: a running "someone
// bought" feed reads as trading-app hype, not a neutral notice.
function newsFor(event: RailEvent): NewsItem | undefined {
  switch (event.kind) {
    case "LAUNCH": {
      const who = event.symbol ? `$${event.symbol}` : event.token ? shortAddress(event.token) : "A token";
      return { key: event.key, tag: "LAUNCH", text: `${who} launched`, chipClass: "chip-accent", timestamp: event.timestamp };
    }
    case "GRADUATED": {
      const who = event.symbol ? `$${event.symbol}` : event.token ? shortAddress(event.token) : "A token";
      return { key: event.key, tag: "BALLASTED", text: `${who} is now ballasted`, chipClass: "chip-accent", timestamp: event.timestamp };
    }
    case "BURN":
      return { key: event.key, tag: "BURN", text: "Buyback burn executed", chipClass: "chip-warning", timestamp: event.timestamp };
    default:
      return undefined;
  }
}

/**
 * Persistent "network activity" panel — EON's Live News slot, but every card
 * is a real on-chain event from the same feed LiveRail/EventToasts already
 * read (useLiveRail, fed by useProjects), never a fabricated headline. Unlike
 * EventToasts this list doesn't auto-dismiss; unlike LiveRail's compact single-
 * line rows, each event gets its own small bordered card so the two panels
 * don't read as the same component twice.
 */
export function NewsPanel({ projects }: { projects: Project[] }) {
  const { events } = useLiveRail(projects);
  const now = useNow();

  const items = events.map(newsFor).filter((x): x is NewsItem => Boolean(x)).slice(0, MAX_ROWS);

  return (
    <div className="card-raised p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 section-label">
          <span className="live-dot h-1.5 w-1.5 rounded-full bg-green" aria-hidden />
          Network activity
        </h2>
      </div>

      {items.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">Nothing yet — launches, ballasted treasuries, and burns will appear here.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.key} className="rounded-input border border-border bg-card p-2.5">
              <div className="flex items-center gap-2">
                <span className={cn("chip", item.chipClass)}>{item.tag}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-text-secondary">{item.text}</span>
              </div>
              {item.timestamp !== undefined && (
                <p className="mt-1 text-xs text-text-faint">{timeAgo(item.timestamp, now)}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
