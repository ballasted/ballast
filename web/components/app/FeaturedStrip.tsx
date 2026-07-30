"use client";

import Link from "next/link";
import type { Project } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { ipfsToGateway } from "@/lib/ipfs";
import { Logo } from "@/components/app/Logo";
import { formatUsd, shortAddress } from "@/lib/format";
import { TOTAL_SUPPLY } from "@/lib/contracts";
import { cn } from "@/lib/cn";

const WAD = 10n ** 18n;

// The featured strip (Phase 4). Where Uniswap shows a bonding-curve progress bar we
// show the BACKING bar — the locked vs creator-withdrawable split — because we have
// no bonding curve and no graduation event, so a progress bar would be meaningless.
//
// Selection: ranked by LOCKED backing, descending; only projects that actually carry
// a treasury qualify, and if fewer than four do we show fewer rather than padding
// with unbacked ones. The protocol token is pinned ABOVE this strip (never inside
// it) — callers pass a list that already excludes it.
export function FeaturedStrip({ projects }: { projects: Project[] }) {
  const featured = [...projects]
    .filter((p) => p.ballasted && p.backing && p.backing.totalValueUsd > 0n)
    .sort((a, b) => {
      const al = a.backing?.lockedValueUsd ?? 0n;
      const bl = b.backing?.lockedValueUsd ?? 0n;
      return bl > al ? 1 : bl < al ? -1 : 0;
    })
    .slice(0, 4);

  if (featured.length === 0) return null;

  const n = featured.length;
  const cols =
    n === 1
      ? "grid-cols-1 max-w-md"
      : n === 2
        ? "grid-cols-1 sm:grid-cols-2"
        : n === 3
          ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
          : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4";

  return (
    <section aria-label="Featured launches">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg font-semibold text-bone">Featured</h2>
        <span className="text-xs text-text-faint">Ranked by locked backing, descending</span>
      </div>
      <div className={cn("grid gap-4", cols)}>
        {featured.map((p, i) => (
          <div key={p.token} className="anim-enter" style={{ animationDelay: `${Math.min(i, 4) * 40}ms` }}>
            <FeaturedCard project={p} />
          </div>
        ))}
      </div>
    </section>
  );
}

function FeaturedCard({ project }: { project: Project }) {
  const { symbol, name, token, metadataURI, backing, marketPriceUsd } = project;
  const { meta } = useProjectMeta(metadataURI);

  const supply = backing?.totalSupply && backing.totalSupply > 0n ? backing.totalSupply : TOTAL_SUPPLY;
  const mcap1e18 = marketPriceUsd !== undefined ? (marketPriceUsd * supply) / WAD : undefined;
  const ratio =
    mcap1e18 !== undefined && backing && backing.totalValueUsd > 0n
      ? Number((mcap1e18 * WAD) / backing.totalValueUsd) / 1e18
      : null;

  const locked = backing?.lockedValueUsd ?? 0n;
  const withdrawable = backing?.withdrawableValueUsd ?? 0n;
  const total = locked + withdrawable;
  const lockedPct = total > 0n ? Number((locked * 10_000n) / total) / 100 : 0;

  return (
    <Link href={`/app/token/${token}`} className="card card-hover block border-accent p-5">
      <div className="flex items-center gap-3">
        <Logo src={ipfsToGateway(meta?.logo)} symbol={symbol} size={48} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-text-primary">{symbol ?? shortAddress(token)}</div>
          <p className="truncate text-sm text-text-muted">{name ?? "Unnamed project"}</p>
        </div>
      </div>

      <div className="mt-4">
        <div className="text-xs uppercase tracking-wide text-text-faint">Market cap</div>
        <div className="figure-primary text-xl tabular-nums">
          {mcap1e18 !== undefined ? (
            <span key={mcap1e18.toString()} className="anim-fade inline-block">
              {formatUsd(mcap1e18, { compact: true })}
            </span>
          ) : (
            <span className="text-text-muted">no pool yet</span>
          )}
        </div>
      </div>

      {/* Backing bar — locked (can never leave) vs creator-withdrawable. A proportion,
          so it may animate: it grows from 0 on first paint only (bar-grow). */}
      <div className="mt-4">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg" role="img"
          aria-label={`${lockedPct.toFixed(0)}% locked, ${(100 - lockedPct).toFixed(0)}% creator-withdrawable`}>
          <span className="bar-grow h-full bg-green" style={{ width: `${lockedPct}%` }} />
          <span className="bar-grow h-full bg-green-mid" style={{ width: `${100 - lockedPct}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-text-muted">
            {formatUsd(locked, { compact: true })} locked · {formatUsd(withdrawable, { compact: true })} withdrawable
          </span>
          {ratio !== null && (
            <span className={ratio >= 1 ? "text-green" : "text-warning"}>{ratio.toFixed(2)}× backing</span>
          )}
        </div>
      </div>
    </Link>
  );
}
