"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Project } from "@/hooks/useProjects";
import { useTrending } from "@/hooks/useTrending";
import { useAssets } from "@/hooks/useAssets";
import { AssetDisc } from "@/components/app/AssetDisc";
import { BackedByChip, PoolChips } from "@/components/app/LaunchChips";
import { shortAddress } from "@/lib/format";
import { formatSmallUsd } from "@/lib/market";
import { cn } from "@/lib/cn";

const MAX_ROWS = 5;
const FLASH_MS = 900;

// Top movers (spec §5.6) — sorted by |24h% change|. Sourced from the SAME
// /api/trending call Discover's Trending view already makes (priceUsd/
// change24hPct ride along free from that pool fetch — see lib/geckoServer.ts
// fetchTopPool), so this doesn't add a new request. A token with no change%
// (GeckoTerminal hasn't priced its pool) is left out rather than shown at 0%.
type BackingAssetView = { asset: `0x${string}` };

export function TopMovers({ projects }: { projects: Project[] }) {
  const trending = useTrending();
  const { assets: registry, isLoading: registryLoading } = useAssets();
  const byToken = new Map(projects.map((p) => [p.token.toLowerCase(), p] as const));

  const movers = (trending.data?.items ?? [])
    .filter((it) => it.change24hPct !== null && it.priceUsd !== null)
    .sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))
    .slice(0, MAX_ROWS);

  // A brief background tint when a real price actually moves between refetches
  // (react-query refetches this every 90s) — EON's "tick" energy, but only
  // ever fired by a genuine changed value, never on a timer of its own.
  const lastPrices = useRef<Map<string, number>>(new Map());
  const [flashes, setFlashes] = useState<Map<string, "up" | "down">>(new Map());
  useEffect(() => {
    const next = new Map<string, "up" | "down">();
    for (const m of movers) {
      const prev = lastPrices.current.get(m.token.toLowerCase());
      if (prev !== undefined && m.priceUsd !== null && m.priceUsd !== prev) {
        next.set(m.token.toLowerCase(), m.priceUsd > prev ? "up" : "down");
      }
    }
    for (const m of movers) if (m.priceUsd !== null) lastPrices.current.set(m.token.toLowerCase(), m.priceUsd);
    if (next.size === 0) return;
    setFlashes(next);
    const t = setTimeout(() => setFlashes(new Map()), FLASH_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trending.data]);

  return (
    <div className="card p-4">
      <h2 className="section-label">Top movers</h2>
      {!trending.available || movers.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">Nothing yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {movers.map((m) => {
            const p = byToken.get(m.token.toLowerCase());
            const up = (m.change24hPct ?? 0) >= 0;
            const flash = flashes.get(m.token.toLowerCase());
            return (
              <li key={m.token}>
                <Link
                  href={`/app/token/${m.token}`}
                  className={cn(
                    "flex items-center gap-2.5 rounded-input px-1.5 py-1.5 transition-colors duration-700 hover:bg-surface-raised",
                    flash === "up" && "bg-green/10",
                    flash === "down" && "bg-negative/10",
                  )}
                >
                  <AssetDisc symbol={p?.symbol} size={24} />
                  <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                    {p?.symbol ?? shortAddress(m.token as `0x${string}`)}
                  </span>
                  {p && (
                    <span className="flex shrink-0 items-center gap-1">
                      <BackedByChip
                        backingAsset={(p.backing?.assets as unknown as BackingAssetView[] | undefined)?.[0]?.asset}
                        registry={registry}
                        registryLoaded={!registryLoading}
                        compact
                      />
                      <PoolChips quoteAssets={p.quoteAssets} registry={registry} registryLoaded={!registryLoading} compact />
                    </span>
                  )}
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
