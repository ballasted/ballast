import type { Project } from "@/hooks/useProjects";
import { activeChain } from "@/lib/chain";
import {
  formatUsd,
  formatBackingPerToken,
  shortAddress,
} from "@/lib/format";

// Card contents follow build-spec §9. Price / % change are shown as "—" until a
// market source (pool/quoter) exists — we never invent a number we can't measure.
// The backing row is real, read live from BackingLens.
export function ProjectCard({ project, hideSparkline }: { project: Project; hideSparkline?: boolean }) {
  const { symbol, name, backing, ballasted, token, treasury } = project;
  const explorer = `${activeChain.blockExplorers.default.url}/address/${treasury}`;

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-bg text-sm font-semibold text-green">
            {(symbol ?? "•").slice(0, 3)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold text-text-primary">
                {symbol ?? shortAddress(token ?? treasury)}
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

      {hideSparkline && (
        // On the New tab we show elapsed time instead of a chart. Creation time
        // needs the factory/indexer; shown as pending for now.
        <div className="mt-2 metric-secondary">New · age pending indexer</div>
      )}

      <a
        href={explorer}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-block text-xs text-text-faint hover:text-text-secondary"
      >
        Verify on-chain ↗
      </a>
    </div>
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
