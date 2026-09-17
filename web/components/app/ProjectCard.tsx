"use client";

import { useState } from "react";
import Link from "next/link";
import type { Project } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useDenylist } from "@/hooks/useDenylist";
import { ipfsToGateway } from "@/lib/ipfs";
import { LiquidityDepthNote } from "@/components/app/LiquidityDepthNote";
import { ProjectLinks } from "@/components/app/ProjectLinks";
import { formatUsd, formatBackingPerToken, shortAddress } from "@/lib/format";
import { formatSmallUsd } from "@/lib/market";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";

// Image-forward launchpad card (build-spec §9 data, restyled). The project logo
// leads as media; a ballasted token gets a green accent border + a "Ballasted"
// badge over the media. Everything honest stays: live on-chain price, backing per
// token, freshness, the thin-liquidity note, and the unknown-wallet flag. The whole
// card links to the token detail page.
export function ProjectCard({
  project,
  hideSparkline,
  firstLaunch,
  featured,
  badge,
}: {
  project: Project;
  hideSparkline?: boolean;
  firstLaunch?: boolean;
  // At very low counts Discover renders one card "featured" — a wider media band —
  // rather than stranding a small card in a wide row (density §1).
  featured?: boolean;
  // Row-context label for the horizontal "New" / "Trending" strips on Discover —
  // distinct from the media band's Ballasted/Graduated badges (those are
  // permanent chain-state; this is "why this card is in THIS row"). Omitted
  // outside those rows.
  badge?: "new" | "trending";
}) {
  const { symbol, name, backing, ballasted, token, metadataURI, hasPool, marketPriceUsd, depthToDoubleUsd } = project;
  const priceStr = marketPriceUsd !== undefined ? formatSmallUsd(Number(marketPriceUsd) / 1e18) : "—";
  const { meta } = useProjectMeta(metadataURI);
  // Denylisted tokens still appear (ticker + address, still links to the token page)
  // but their project-supplied metadata is withheld: no logo, no display name, no
  // links. Default-allow: undenied unless listed.
  const { isDenied } = useDenylist();
  const denied = isDenied(token);
  const shownMeta = denied ? undefined : meta;
  const logo = ipfsToGateway(shownMeta?.logo);

  return (
    <Link
      href={`/app/token/${token}`}
      className={cn("card card-hover group block overflow-hidden", ballasted && "border-accent")}
    >
      <CardMedia
        logo={logo}
        symbol={symbol}
        ballasted={ballasted}
        hasPool={hasPool}
        badge={badge}
        aspect={featured ? "aspect-[16/9]" : "aspect-[16/10]"}
      />

      <div className={cn(featured ? "p-5" : "p-4")}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold text-text-primary">{symbol ?? shortAddress(token)}</span>
              {ballasted && <VerifiedCheck />}
            </div>
            <p className="truncate text-sm text-text-muted">
              {denied ? <span className="italic text-text-faint">Metadata withheld</span> : (name ?? "Unnamed project")}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div key={priceStr} className="figure-primary anim-fade text-lg tabular-nums">{priceStr}</div>
            <div className="metric-secondary inline-flex items-center justify-end gap-1">
              {hasPool && <span className="h-1.5 w-1.5 rounded-full bg-green" aria-hidden />}
              {hasPool ? "market price" : "no pool yet"}
            </div>
          </div>
        </div>

        <div className="mt-3 border-t border-border pt-3">
          {ballasted && backing ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-sm text-text-secondary">
                  Backing {formatBackingPerToken(backing.backingPerToken)} / token
                </span>
                <div className="metric-secondary mt-0.5">
                  {formatUsd(backing.totalValueUsd, { compact: true })} total ·{" "}
                  {formatUsd(backing.lockedValueUsd, { compact: true })} locked
                </div>
              </div>
              {backing.anyStale && <span className="chip chip-warning shrink-0">prices resting</span>}
            </div>
          ) : (
            <span className="text-sm text-text-muted">
              {hasPool ? "No treasury · trading" : "No treasury · no pool yet"}
            </span>
          )}
        </div>

        <LiquidityDepthNote depthToDoubleUsd={depthToDoubleUsd} className="mt-2" />

        {firstLaunch && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-warning">
            <span aria-hidden>◆</span> First launch · no track record yet
          </div>
        )}

        {hideSparkline && <div className="mt-1 metric-secondary">New · ordered by launch</div>}

        <ProjectLinks meta={shownMeta} variant="icons" className="mt-3" />

        {/* Footer — contract address only. No "time since launch": the registry
            gives chain order, not a timestamp, and guessing an age would be
            exactly the kind of fabricated figure this app refuses to show. */}
        <div className="mt-3 border-t border-border pt-2">
          <span className="font-mono text-xs text-text-faint">{shortAddress(token)}</span>
        </div>
      </div>
    </Link>
  );
}

// Media band: the project logo, filled; falls back to a branded initials plate when
// there's no image (or it fails / is withheld), so a card is never a broken image
// and never a bare grey box. A ballasted token is tinted green and badged.
function CardMedia({
  logo,
  symbol,
  ballasted,
  hasPool,
  badge,
  aspect,
}: {
  logo?: string;
  symbol?: string;
  ballasted: boolean;
  hasPool: boolean;
  // Row-context status (New / Trending) from the horizontal Discover strips —
  // takes the media's top-right corner in place of the hasPool indicator,
  // which stays available in the price sub-line below either way. Omitted
  // outside those rows, where the hasPool pill renders as before.
  badge?: "new" | "trending";
  aspect: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = Boolean(logo) && !failed;
  return (
    <div className={cn("relative w-full overflow-hidden border-b border-border", aspect, ballasted ? "bg-green-bg" : "bg-surface-raised")}>
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          aria-hidden
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : (
        // Branded fallback plate — ticker initials over a faint meander rule, so a
        // logo-less token reads as designed, not as a missing image.
        <div className="flex h-full w-full items-center justify-center">
          <span className="select-none font-serif text-4xl font-semibold tracking-tight text-bone/55">
            {(symbol || "•").slice(0, 3).toUpperCase()}
          </span>
          <Meander className="absolute inset-x-0 bottom-3 px-6 opacity-40" />
        </div>
      )}
      {ballasted && (
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-bg/85 px-2 py-1 text-[11px] font-medium text-green backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-green" aria-hidden /> Ballasted
        </span>
      )}
      {/* Row-context status (New / Trending — spec §2 horizontal strips) takes the
          corner when present; otherwise the binary hasPool state, not a progress
          bar — there's no on-chain graduation threshold to show a % toward
          (Milestone 1 decision). hasPool alone says whether this token trades in
          the AMM pool or is still pre-pool. */}
      {badge ? (
        <span
          className={cn(
            "absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-bg/85 px-2 py-1 text-[11px] font-medium backdrop-blur",
            badge === "trending" ? "text-warning" : "text-text-muted",
          )}
        >
          {badge === "trending" ? "Trending" : "New"}
        </span>
      ) : (
        <span
          className={cn(
            "absolute right-2 top-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium backdrop-blur",
            hasPool ? "bg-bg/85 text-green" : "bg-bg/85 text-text-muted",
          )}
        >
          {hasPool ? "Graduated" : "On curve"}
        </span>
      )}
    </div>
  );
}

function VerifiedCheck() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-label="ballasted" className="shrink-0">
      <circle cx="12" cy="12" r="10" fill="#0F2A14" />
      <path d="M8 12.5l2.5 2.5L16 9" stroke="#22C93A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
