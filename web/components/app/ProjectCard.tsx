"use client";

import Link from "next/link";
import type { Project } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { ipfsToGateway } from "@/lib/ipfs";
import { Logo } from "@/components/app/Logo";
import { formatUsd, formatBackingPerToken, shortAddress } from "@/lib/format";

// Card contents follow build-spec §9. Price / % change are shown as "—" until a
// market source (pool/quoter) exists — we never invent a number we can't measure.
// The backing row is real, read live from BackingLens. The whole card links to the
// token detail page (keyed by treasury address for now; see that page's note).
export function ProjectCard({
  project,
  hideSparkline,
  firstLaunch,
}: {
  project: Project;
  hideSparkline?: boolean;
  firstLaunch?: boolean;
}) {
  const { symbol, name, backing, ballasted, token, metadataURI } = project;
  // Resolve the pinned logo from the token's on-chain metadataURI — same source
  // the token page uses. Without this the card only ever showed ticker initials
  // (Part C bug 10). Logo falls back to initials if the CID is missing/broken.
  const { meta } = useProjectMeta(metadataURI);

  return (
    <Link
      href={`/app/token/${token}`}
      className={`card card-hover block p-4 ${ballasted ? "border-accent" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Logo src={ipfsToGateway(meta?.logo)} symbol={symbol} size={40} />
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
          {/* Market price/change require a pool + quoter (not built). Honest "—". */}
          <div className="figure-primary">—</div>
          <div className="metric-secondary">price n/a</div>
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
          <span className="text-sm text-text-muted">Not ballasted · no treasury</span>
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
