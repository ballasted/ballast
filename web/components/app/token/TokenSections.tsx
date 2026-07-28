"use client";

import Link from "next/link";
import { formatUnits, type Address } from "viem";
import { useProjects } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useHolders } from "@/hooks/useHolders";
import { useIndexerStatus } from "@/hooks/useIndexerStatus";
import { formatUsd, shortAddress } from "@/lib/format";
import { formatCompactUsd } from "@/lib/market";
import { holderSharePct, BLOCKSCOUT_URL, type Holder } from "@/lib/blockscout";
import { formatEt } from "@/lib/marketHours";
import { ipfsToGateway } from "@/lib/ipfs";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";

const WAD = 10n ** 18n;

// ── Market overview ─────────────────────────────────────────────────────────
// FDV is derived live on-chain (market price × supply). Liquidity + 24h volume come
// from GeckoTerminal, holder count from Blockscout — each labelled with its source.
// A figure whose source is unavailable shows "—", never a fabricated number.
export function MarketOverview({
  marketPriceUsd,
  totalSupply,
  hasPool,
  liquidityUsd,
  volume24hUsd,
  holdersCount,
}: {
  marketPriceUsd?: bigint;
  totalSupply?: bigint;
  hasPool: boolean;
  liquidityUsd?: number; // GeckoTerminal, top pool reserve
  volume24hUsd?: number; // GeckoTerminal
  holdersCount?: number; // Blockscout
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
        <Stat label="Liquidity" value={liquidityUsd !== undefined ? formatCompactUsd(liquidityUsd) : "—"} />
        <Stat label="Holders" value={holdersCount !== undefined ? holdersCount.toLocaleString("en") : "—"} />
        <Stat label="24h volume" value={volume24hUsd !== undefined ? formatCompactUsd(volume24hUsd) : "—"} />
      </dl>
      <p className="mt-4 text-xs text-text-faint">
        FDV is market price × total supply, computed live on-chain. Liquidity and 24h volume are from GeckoTerminal;
        holder count from Blockscout. A dash means that source has nothing for this token yet.
      </p>
    </section>
  );
}

// ── Holders (Blockscout) ──────────────────────────────────────────────────────
// Full history from block zero via Blockscout's free API — a better source than our
// own indexer (which would start at a deploy block). Labels the LP, seeder, creator,
// and treasury so a reader understands WHY one address can hold most of the supply
// (the seeded, permanently-locked pool position), rather than reading it as a rug.
export function HoldersPanel({
  token,
  creator,
  treasury,
  now,
}: {
  token: Address;
  creator?: Address;
  treasury?: Address;
  now: number;
}) {
  const { holders, isLoading } = useHolders(token);

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-faint">Holders</h2>
        {holders?.holdersCount !== undefined && (
          <span className="text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">{holders.holdersCount.toLocaleString("en")}</span> total
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-surface-raised" />
          ))}
        </div>
      ) : !holders?.available || holders.holders.length === 0 ? (
        <div className="mt-4 flex flex-col items-center py-6 text-center">
          <Meander className="mb-4 max-w-[100px] opacity-60" />
          <p className="max-w-sm text-sm text-text-muted">
            {holders?.reason === "not-found"
              ? "No transfers indexed for this token yet — until someone trades, the pool holds essentially the whole supply."
              : "Blockscout is unreachable right now, so the holder list is shown as unavailable rather than a stale figure."}
          </p>
        </div>
      ) : (
        <>
          <ul className="mt-4 space-y-1.5">
            {holders.holders.slice(0, 10).map((h) => (
              <HolderRow
                key={h.address}
                h={h}
                decimals={holders.decimals ?? 18}
                totalSupply={holders.totalSupply}
                label={holderLabel(h, creator, treasury)}
              />
            ))}
          </ul>
          <p className="mt-4 text-[11px] text-text-faint">
            Source: Blockscout (full transfer history){holders.fetchedAt ? ` · updated ${formatEt(holders.fetchedAt)}` : ""}.
            Balances are chain truth; labels explain known addresses.
          </p>
        </>
      )}
    </section>
  );
}

type HolderKind = "lp" | "seeder" | "creator" | "treasury" | "contract" | "wallet";

function holderLabel(h: Holder, creator?: Address, treasury?: Address): { text: string; kind: HolderKind } | null {
  const a = h.address.toLowerCase();
  if (creator && a === creator.toLowerCase()) return { text: "Creator", kind: "creator" };
  if (treasury && a === treasury.toLowerCase()) return { text: "Treasury", kind: "treasury" };
  const name = h.name ?? "";
  if (/poolmanager/i.test(name)) return { text: "Liquidity pool · locked", kind: "lp" };
  if (/seeder/i.test(name)) return { text: "Seeder", kind: "seeder" };
  if (name) return { text: name, kind: "contract" };
  if (h.isContract) return { text: "Contract", kind: "contract" };
  return null;
}

function HolderRow({
  h,
  decimals,
  totalSupply,
  label,
}: {
  h: Holder;
  decimals: number;
  totalSupply?: string;
  label: { text: string; kind: HolderKind } | null;
}) {
  const amount = Number(formatUnits(BigInt(h.value || "0"), decimals)).toLocaleString("en", {
    maximumFractionDigits: 2,
    notation: "compact",
  });
  const pct = holderSharePct(h.value, totalSupply);
  const tone =
    label?.kind === "lp"
      ? "bg-green-bg text-green"
      : label?.kind === "creator"
        ? "bg-warning-bg text-warning"
        : "bg-border text-text-secondary";
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <a
          href={`${BLOCKSCOUT_URL}/address/${h.address}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-text-primary hover:text-green"
        >
          {shortAddress(h.address as Address)}
        </a>
        {label && <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", tone)}>{label.text}</span>}
      </div>
      <div className="shrink-0 text-right">
        <span className="text-text-primary">{amount}</span>
        {pct !== undefined && <span className="metric-secondary ml-2">{pct < 0.01 ? "<0.01" : pct.toFixed(2)}%</span>}
      </div>
    </li>
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
