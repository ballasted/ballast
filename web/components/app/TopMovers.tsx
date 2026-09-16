"use client";

import Link from "next/link";
import type { Project } from "@/hooks/useProjects";
import { useTrending } from "@/hooks/useTrending";
import { AssetDisc } from "@/components/app/AssetDisc";
import { shortAddress } from "@/lib/format";
import { formatSmallUsd } from "@/lib/market";
import { cn } from "@/lib/cn";

const MAX_ROWS = 5;

// Top movers (spec §5.6) — sorted by |24h% change|. Sourced from the SAME
// /api/trending call Discover's Trending view already makes (priceUsd/
// change24hPct ride along free from that pool fetch — see lib/geckoServer.ts
// fetchTopPool), so this doesn't add a new request. A token with no change%
// (GeckoTerminal hasn't priced its pool) is left out rather than shown at 0%.
export function TopMovers({ projects }: { projects: Project[] }) {
  const trending = useTrending();
  const byToken = new Map(projects.map((p) => [p.token.toLowerCase(), p] as const));

  const movers = (trending.data?.items ?? [])
    .filter((it) => it.change24hPct !== null && it.priceUsd !== null)
    .sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))
    .slice(0, MAX_ROWS);

  return (
    <div className="card p-4">
      <h2 className="section-label">Top movers</h2>
      {!trending.available ? (
        <p className="mt-3 text-sm text-text-muted">GeckoTerminal didn’t respond, so movers are paused.</p>
      ) : movers.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">Not enough priced pools yet to rank movers.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {movers.map((m) => {
            const p = byToken.get(m.token.toLowerCase());
            const up = (m.change24hPct ?? 0) >= 0;
            return (
              <li key={m.token}>
                <Link
                  href={`/app/token/${m.token}`}
                  className="flex items-center gap-2.5 rounded-input px-1.5 py-1.5 transition-colors hover:bg-surface-raised"
                >
                  <AssetDisc symbol={p?.symbol} size={24} />
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                    {p?.symbol ?? shortAddress(m.token as `0x${string}`)}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-text-secondary">
                    {formatSmallUsd(m.priceUsd!)}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-mono text-xs tabular-nums",
                      up ? "text-green" : "text-negative",
                    )}
                  >
                    {up ? "▲" : "▼"} {Math.abs(m.change24hPct!).toFixed(1)}%
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
