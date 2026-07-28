"use client";

import Link from "next/link";
import type { Project } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { ipfsToGateway } from "@/lib/ipfs";
import { Logo } from "@/components/app/Logo";
import { formatUsd, formatBackingPerToken, shortAddress } from "@/lib/format";
import { formatSmallUsd } from "@/lib/market";

// Card contents follow build-spec §9. The market price is read live on-chain from
// the v4 StateView (via useProjects) — always available once a pool exists — so a
// trading token never shows "price n/a". The backing row is read from BackingLens.
// The whole card links to the token detail page.
export function ProjectCard({
  project,
  hideSparkline,
  firstLaunch,
  featured,
}: {
  project: Project;
  hideSparkline?: boolean;
  firstLaunch?: boolean;
  // At very low counts Discover renders one card "featured" — wider padding and a
  // larger mark — rather than stranding a small card in a wide row (density §1).
  featured?: boolean;
}) {
  const { symbol, name, backing, ballasted, token, metadataURI, hasPool, marketPriceUsd } = project;
  const priceStr = marketPriceUsd !== undefined ? formatSmallUsd(Number(marketPriceUsd) / 1e18) : "—";
  // Resolve the pinned logo from the token's on-chain metadataURI — same source
  // the token page uses. Without this the card only ever showed ticker initials
  // (Part C bug 10). Logo falls back to initials if the CID is missing/broken.
  const { meta } = useProjectMeta(metadataURI);

  return (
    <Link
      href={`/app/token/${token}`}
      className={`card card-hover block ${featured ? "p-6" : "p-4"} ${ballasted ? "border-accent" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Logo src={ipfsToGateway(meta?.logo)} symbol={symbol} size={featured ? 56 : 40} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold text-text-primary">
                {symbol ?? shortAddress(token)}
              </span>
              {ballasted && <VerifiedCheck />}
            </div>
            <p className="truncate text-sm text-text-muted">{name ?? "Unnamed project"}</p>
          </div>
        </div>
        <div className="text-right">
          {/* Live on-chain market price (pool mid × ETH/USD). Crossfades on change. */}
          <div key={priceStr} className="figure-primary anim-fade">{priceStr}</div>
          <div className="metric-secondary">{hasPool ? "market price" : "no pool yet"}</div>
        </div>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        {ballasted && backing ? (
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="text-sm text-text-secondary">
                Backing {formatBackingPerToken(backing.backingPerToken)} / token
              </span>
              <div className="metric-secondary mt-0.5">
                {formatUsd(backing.totalValueUsd, { compact: true })} total ·{" "}
                {formatUsd(backing.lockedValueUsd, { compact: true })} locked
              </div>
            </div>
            {backing.anyStale && (
              <span className="rounded bg-warning-bg px-2 py-0.5 text-xs text-warning">
                prices resting
              </span>
            )}
          </div>
        ) : (
          // No treasury — but distinguish a live pool from a token with none, so
          // "no treasury" doesn't blur into "nothing launched" on a trading token.
          <span className="text-sm text-text-muted">
            {hasPool ? "No treasury · trading" : "No treasury · no pool yet"}
          </span>
        )}
      </div>

      {/* A new wallet is UNKNOWN, not safe. Amber, visually distinct from the
          green verified check (spec §9). */}
      {firstLaunch && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-warning">
          <span aria-hidden>◆</span> First launch · no track record yet
        </div>
      )}

      {hideSparkline && (
        // On the New tab we show elapsed time instead of a chart. Precise creation
        // time needs event logs; the registry preserves launch order regardless.
        <div className="mt-1 metric-secondary">New · ordered by launch</div>
      )}
    </Link>
  );
}

function VerifiedCheck() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-label="ballasted" className="shrink-0">
      <circle cx="12" cy="12" r="10" fill="#0E2A12" />
      <path d="M8 12.5l2.5 2.5L16 9" stroke="#00C805" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
