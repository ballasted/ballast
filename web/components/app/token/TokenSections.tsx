"use client";

import Link from "next/link";
import { formatUnits, type Address } from "viem";
import { useProjects } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useHolders } from "@/hooks/useHolders";
import { useTrades } from "@/hooks/useTrades";
import { formatUsd, shortAddress } from "@/lib/format";
import { formatCompactUsd, formatSmallUsd, marketCapUsd, type Trade } from "@/lib/market";
import { activeChain } from "@/lib/chain";
import { holderSharePct, BLOCKSCOUT_URL, type Holder } from "@/lib/blockscout";
import { formatEt } from "@/lib/marketHours";
import { ipfsToGateway } from "@/lib/ipfs";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";


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
  // Same helper as Discover + the featured strip, so a token's market cap (FDV) is
  // identical wherever it appears (spec 1.4). The caller passes the canonical supply.
  const fdv = totalSupply !== undefined ? marketCapUsd(marketPriceUsd, totalSupply) : undefined;

  return (
    <section className="card p-5">
      <h2 className="section-label">Market overview</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        <Stat label="FDV" value={fdv !== undefined ? formatUsd(fdv, { compact: true }) : hasPool ? "—" : "no market"} />
        <Stat label="Liquidity" value={liquidityUsd !== undefined ? formatCompactUsd(liquidityUsd) : "—"} />
        <Stat label="Holders" value={holdersCount !== undefined ? holdersCount.toLocaleString("en") : "—"} />
        <Stat label="24h volume" value={volume24hUsd !== undefined ? formatCompactUsd(volume24hUsd) : "—"} />
      </dl>
      <p className="mt-4 text-xs text-text-faint">
        FDV = price × supply, computed on-chain. Liquidity/volume from GeckoTerminal, holders from Blockscout. A dash
        means that source has nothing yet.
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
        <h2 className="section-label">Holders</h2>
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
              ? "No transfers indexed yet — the pool holds essentially the whole supply until someone trades."
              : "Blockscout is unreachable, so the holder list shows unavailable rather than stale."}
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
            Source: Blockscout (full history){holders.fetchedAt ? ` · updated ${formatEt(holders.fetchedAt)}` : ""}.
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
      <h2 className="section-label">Supply &amp; allocation</h2>
      <div className="mt-3 flex items-baseline gap-3">
        <span className="figure-primary text-3xl text-green">100%</span>
        <span className="text-sm text-text-secondary">of supply seeded the pool</span>
      </div>
      <p className="mt-3 text-sm text-text-secondary">
        The creator holds <span className="font-semibold text-text-primary">none</span> — no presale, team bag, or
        vesting. No allocation chart because there&apos;s no allocation: the one thing that sets a BALLAST launch apart.
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
      <h2 className="section-label">Metadata history</h2>
      <ol className="mt-3 space-y-3">
        {changed && (
          <HistoryRow
            tag="Current"
            tagClass="chip-accent"
            name={currentMeta.meta?.name}
            uri={currentUri}
          />
        )}
        <HistoryRow
          tag="Launch · original"
          tagClass="chip-neutral"
          name={launchMeta.meta?.name}
          uri={launchUri}
        />
      </ol>
      <p className="mt-4 text-xs text-text-faint">
        {changed
          ? "Updated since launch; the launch version above is permanent."
          : "Unchanged since launch."}{" "}
        A dated change-by-change timeline needs indexing; until then, each MetadataUpdated event is readable on the
        explorer.
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
        <span className={cn("chip", tagClass)}>{tag}</span>
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
// Launches by this creator, how many are still ballasted, and their total ballast
// across launches — all derived live from the factory registry + BackingLens. The
// old "Active since" stat needed per-launch timestamps, which the registry doesn't
// carry and Blockscout doesn't expose directly (it would take a per-tx creation-time
// lookup across every launch — indexer territory). Rather than a "needs indexer"
// placeholder, we show a figure we CAN source: total ballast across this creator's
// launches.
export function CreatorTrackRecord({ creator, thisToken }: { creator?: Address; thisToken: Address }) {
  const { projects, isConfigured } = useProjects();

  if (!creator || !isConfigured) return null;

  const mine = projects.filter((p) => p.creator.toLowerCase() === creator.toLowerCase());
  const stillBallasted = mine.filter((p) => p.ballasted).length;
  const creatorBallastUsd = mine.reduce((s, p) => s + (p.backing?.totalValueUsd ?? 0n), 0n);
  const others = mine.filter((p) => p.token.toLowerCase() !== thisToken.toLowerCase());

  return (
    <section className="card p-5">
      <h2 className="section-label">Creator track record</h2>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-sm text-text-muted">Creator</span>
        <span className="font-mono text-sm text-text-primary">{shortAddress(creator)}</span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-3">
        <Stat label="Launches" value={String(mine.length)} />
        <Stat label="Still ballasted" value={String(stillBallasted)} />
        <Stat label="Ballast across launches" value={formatUsd(creatorBallastUsd, { compact: true })} />
      </dl>

      {others.length > 0 && (
        <>
          <Meander className="my-4 opacity-60" />
          <div className="space-y-2">
            <div className="eyebrow">Other launches</div>
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

// ── Recent trades (GeckoTerminal) ─────────────────────────────────────────────
// The pool's trade feed: direction, size, price, wallet, age. Degrades to an honest
// state — never a stale row or a fabricated trade. Backing and price above are
// chain-read and independent of this.
export function TradesPanel({ token, symbol, now }: { token: Address; symbol?: string; now: number }) {
  const { data, isLoading } = useTrades(token);

  // Buys vs sells over the recent SAMPLE (not the full 24h — that needs an indexer).
  const trades = data?.trades ?? [];
  const shown = trades.slice(0, 15);
  const buyVol = trades.filter((t) => t.kind === "buy").reduce((s, t) => s + t.volumeUsd, 0);
  const sellVol = trades.filter((t) => t.kind === "sell").reduce((s, t) => s + t.volumeUsd, 0);
  const totalVol = buyVol + sellVol;
  const buyPct = totalVol > 0 ? (buyVol / totalVol) * 100 : 50;
  const buyCount = trades.filter((t) => t.kind === "buy").length;
  const sellCount = trades.length - buyCount;

  return (
    <section className="card p-5">
      <h2 className="section-label">Recent trades</h2>

      {isLoading ? (
        <div className="mt-4 space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-surface-raised" />
          ))}
        </div>
      ) : !data?.available || data.trades.length === 0 ? (
        <div className="mt-4 flex flex-col items-center py-6 text-center">
          <Meander className="mb-4 max-w-[100px] opacity-60" />
          <p className="max-w-sm text-sm text-text-muted">
            {data?.reason === "not-indexed"
              ? "No trades yet — the feed fills in once the pool trades. Price and backing above are already chain-live."
              : "GeckoTerminal is unreachable, so the trade feed shows unavailable rather than stale."}
          </p>
        </div>
      ) : (
        <>
          {/* Buys vs sells over the sample — an at-a-glance sentiment read. */}
          <div className="mt-3">
            <div className="flex h-2 overflow-hidden rounded-full bg-border" aria-hidden>
              <div className="bg-green" style={{ width: `${buyPct}%` }} />
              <div className="bg-negative" style={{ width: `${100 - buyPct}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] tabular-nums">
              <span className="text-green">{buyCount} buys · {formatCompactUsd(buyVol)}</span>
              <span className="text-negative">{formatCompactUsd(sellVol)} · {sellCount} sells</span>
            </div>
          </div>

          {/* Desktop table (denser scan), cards on mobile. */}
          <div className="mt-3 hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="eyebrow text-left">
                  <th className="pb-2 font-medium">Time</th>
                  <th className="pb-2 font-medium">Side</th>
                  <th className="pb-2 text-right font-medium">Value</th>
                  <th className="pb-2 text-right font-medium">Amount</th>
                  <th className="pb-2 text-right font-medium">Price</th>
                  <th className="pb-2 text-right font-medium">Trader</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((t, i) => (
                  <tr key={`${t.txHash}-${i}`}>
                    <td className="py-2 text-text-secondary">{fmtAgo(Math.max(0, now - t.ts))}</td>
                    <td className="py-2">
                      <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", t.kind === "buy" ? "bg-green-bg text-green" : "bg-negative/10 text-negative")}>
                        {t.kind === "buy" ? "Buy" : "Sell"}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums text-text-primary">{formatCompactUsd(t.volumeUsd)}</td>
                    <td className="py-2 text-right tabular-nums text-text-secondary">
                      {t.tokenAmount.toLocaleString("en", { maximumFractionDigits: 2, notation: "compact" })}
                    </td>
                    <td className="py-2 text-right tabular-nums text-text-secondary">{formatSmallUsd(t.priceUsd)}</td>
                    <td className="py-2 text-right">
                      <a href={`${activeChain.blockExplorers.default.url}/address/${t.wallet}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-text-faint hover:text-green">
                        {shortAddress(t.wallet as Address)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-3 space-y-1.5 sm:hidden">
            {shown.map((t, i) => (
              <TradeRow key={`${t.txHash}-${i}`} t={t} symbol={symbol} now={now} />
            ))}
          </ul>

          <p className="mt-4 text-[11px] text-text-faint">
            Source: GeckoTerminal{data.fetchedAt ? ` · updated ${formatEt(data.fetchedAt)}` : ""}. A live sample of
            recent trades, not the full 24h — so the split above covers this sample only; 24h volume elsewhere is the
            full-window aggregate.
          </p>
        </>
      )}
    </section>
  );
}

function TradeRow({ t, symbol, now }: { t: Trade; symbol?: string; now: number }) {
  const buy = t.kind === "buy";
  const amount = t.tokenAmount.toLocaleString("en", { maximumFractionDigits: 2, notation: "compact" });
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", buy ? "bg-green-bg text-green" : "bg-negative/10 text-negative")}>
          {buy ? "Buy" : "Sell"}
        </span>
        <span className="truncate text-text-primary">
          {amount} <span className="text-text-faint">${symbol ?? "TOKEN"}</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-right">
        <span className="text-text-secondary">{formatSmallUsd(t.priceUsd)}</span>
        <a
          href={`${activeChain.blockExplorers.default.url}/address/${t.wallet}`}
          target="_blank"
          rel="noreferrer"
          className="hidden font-mono text-xs text-text-faint hover:text-green sm:inline"
        >
          {shortAddress(t.wallet as Address)}
        </a>
        <span className="metric-secondary w-10 text-right">{fmtAgo(Math.max(0, now - t.ts))}</span>
      </div>
    </li>
  );
}

function fmtAgo(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
