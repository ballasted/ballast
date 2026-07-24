"use client";

import Link from "next/link";
import type { Address } from "viem";
import { useProjects } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useIndexerStatus } from "@/hooks/useIndexerStatus";
import { formatUsd, shortAddress } from "@/lib/format";
import { ipfsToGateway } from "@/lib/ipfs";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";

const WAD = 10n ** 18n;

// ── Market overview ─────────────────────────────────────────────────────────
// FDV is derived live on-chain (market price × supply). Liquidity in USD, holder
// count, and 24h volume are NOT readable from chain state at speed — they need the
// indexer (Phase 3) — so they carry an honest "needs indexer" label instead of a
// fabricated number. A figure with no source never gets shown as if it had one.
export function MarketOverview({
  marketPriceUsd,
  totalSupply,
  hasPool,
}: {
  marketPriceUsd?: bigint;
  totalSupply?: bigint;
  hasPool: boolean;
}) {
  const fdv =
    marketPriceUsd !== undefined && totalSupply !== undefined
      ? (marketPriceUsd * totalSupply) / WAD
      : undefined;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Market overview</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Stat label="FDV" value={fdv !== undefined ? formatUsd(fdv, { compact: true }) : hasPool ? "—" : "no market"} />
        <Stat label="Liquidity" pending value="needs indexer" />
        <Stat label="Holders" pending value="needs indexer" />
        <Stat label="24h volume" pending value="needs indexer" />
      </dl>
      <p className="mt-4 text-xs text-text-faint">
        FDV is market price × total supply, computed live. Liquidity, holders, and volume come from the indexer, which
        isn&apos;t wired yet — shown as labels rather than guessed.
      </p>
    </section>
  );
}

function Stat({ label, value, pending }: { label: string; value: string; pending?: boolean }) {
  return (
    <div>
      <dd className={cn("figure-primary text-lg", pending && "text-text-faint")}>{value}</dd>
      <dt className="metric-secondary mt-0.5">{label}</dt>
    </div>
  );
}

// ── Allocation slot (spec 5) ────────────────────────────────────────────────
// The answer a founder arriving from Virtuals is looking for: there is no chart
// because there is no allocation. Stated as fact, not a donut.
export function AllocationSlot() {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Supply &amp; allocation</h2>
      <div className="mt-3 flex items-baseline gap-3">
        <span className="figure-primary text-3xl text-green">100%</span>
        <span className="text-sm text-text-secondary">of supply seeded the pool</span>
      </div>
      <p className="mt-3 text-sm text-text-secondary">
        The creator holds <span className="font-semibold text-text-primary">none</span> — no presale, no team bag, no
        vesting cliff. There is no allocation chart because there is no allocation. This is the one thing that makes a
        BALLAST launch structurally different from every launchpad on this chain.
      </p>
    </section>
  );
}

// ── Metadata change history (spec 5) ────────────────────────────────────────
// Built from on-chain truth: the immutable launch URI vs the current URI, and the
// token's own metadataChanged flag. The full timeline of every intermediate change
// (with timestamps, from MetadataUpdated logs) is an indexer job — labelled, not faked.
export function MetadataHistory({
  launchUri,
  currentUri,
  changed,
}: {
  launchUri?: string;
  currentUri?: string;
  changed: boolean;
}) {
  const launchMeta = useProjectMeta(launchUri);
  const currentMeta = useProjectMeta(currentUri);

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Metadata history</h2>
      <ol className="mt-3 space-y-3">
        {changed && (
          <HistoryRow
            tag="Current"
            tagClass="bg-green-bg text-green"
            name={currentMeta.meta?.name}
            uri={currentUri}
          />
        )}
        <HistoryRow
          tag="Launch · original"
          tagClass="bg-border text-text-secondary"
          name={launchMeta.meta?.name}
          uri={launchUri}
        />
      </ol>
      <p className="mt-4 text-xs text-text-faint">
        {changed
          ? "Metadata has been updated since launch. The launch version above is permanent and always readable on-chain."
          : "Unchanged since launch — the current metadata is the original."}{" "}
        The dated timeline of every change comes from the indexer, which isn&apos;t wired yet.
      </p>
    </section>
  );
}

function HistoryRow({
  tag,
  tagClass,
  name,
  uri,
}: {
  tag: string;
  tagClass: string;
  name?: string;
  uri?: string;
}) {
  const gw = ipfsToGateway(uri);
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2">
        <span className={cn("rounded px-2 py-0.5 text-xs font-medium", tagClass)}>{tag}</span>
        <span className="text-text-primary">{name ?? "metadata"}</span>
      </div>
      {gw && (
        <a href={gw} target="_blank" rel="noreferrer" className="text-xs text-text-faint hover:text-text-secondary">
          View JSON ↗
        </a>
      )}
    </li>
  );
}

// ── Creator track record (spec 5) ───────────────────────────────────────────
// Launches by this creator and how many are still ballasted — both derived live
// from the factory registry + BackingLens. "Active since" needs launch timestamps
// (indexer), so it's labelled rather than invented.
export function CreatorTrackRecord({ creator, thisToken }: { creator?: Address; thisToken: Address }) {
  const { projects, isConfigured } = useProjects();

  if (!creator || !isConfigured) return null;

  const mine = projects.filter((p) => p.creator.toLowerCase() === creator.toLowerCase());
  const stillBallasted = mine.filter((p) => p.ballasted).length;
  const others = mine.filter((p) => p.token.toLowerCase() !== thisToken.toLowerCase());

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Creator track record</h2>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-sm text-text-muted">Creator</span>
        <span className="font-mono text-sm text-text-primary">{shortAddress(creator)}</span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-3">
        <Stat label="Launches" value={String(mine.length)} />
        <Stat label="Still ballasted" value={String(stillBallasted)} />
        <Stat label="Active since" value="needs indexer" pending />
      </dl>

      {others.length > 0 && (
        <>
          <Meander className="my-4 opacity-60" />
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-text-faint">Other launches</div>
            {others.map((p) => (
              <Link
                key={p.token}
                href={`/app/token/${p.token}`}
                className="flex items-center justify-between rounded-input border border-border px-3 py-2 text-sm transition-colors hover:border-text-faint"
              >
                <span className="text-text-primary">{p.symbol ? `$${p.symbol}` : shortAddress(p.token)}</span>
                <span className="metric-secondary">
                  {p.ballasted ? formatUsd(p.backing?.lockedValueUsd ?? 0n, { compact: true }) + " locked" : "unbacked"}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ── Holders + trades — honest, indexer-status-aware states ───────────────────
// Never shows a stale or zero value: if the indexer is unreachable or behind, it
// says so plainly instead of rendering an old figure (spec Phase 3 degradation).
export function PendingDataPanel({ title, what }: { title: string; what: string }) {
  const status = useIndexerStatus();

  const message =
    status.state === "down"
      ? "The indexer is unreachable right now, so this is shown as unavailable rather than a stale figure."
      : status.state === "delayed"
        ? `The indexer is catching up${
            status.lastIndexedAt
              ? ` (last update ${Math.max(1, Math.round((Date.now() / 1000 - status.lastIndexedAt) / 60))} min ago)`
              : ""
          } — figures appear once it's current.`
        : what;

  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">{title}</h2>
      <div className="mt-4 flex flex-col items-center py-6 text-center">
        <Meander className="mb-4 max-w-[100px] opacity-60" />
        <p className="max-w-sm text-sm text-text-muted">{message}</p>
        {(status.state === "down" || status.state === "delayed") && (
          <p className="mt-2 text-xs text-warning">Backing and price above are read from the chain and stay live.</p>
        )}
      </div>
    </section>
  );
}
