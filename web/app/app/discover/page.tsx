"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useProjects, type Project } from "@/hooks/useProjects";
import { useTrending } from "@/hooks/useTrending";
import { useProtocolHolders } from "@/hooks/useProtocolHolders";
import { ProjectCard } from "@/components/app/ProjectCard";
import { DiscoverStats } from "@/components/app/DiscoverStats";
import { FeaturedStrip } from "@/components/app/FeaturedStrip";
import { PinnedProtocolCard } from "@/components/app/PinnedProtocolCard";
import { SortRail, type SortId } from "@/components/app/SortRail";
import { isProtocolToken } from "@/components/app/token/ProtocolTokenNotice";
import { formatEt } from "@/lib/marketHours";
import { marketCapUsd, marketCapSupply } from "@/lib/market";
import { Meander } from "@/components/Meander";
import { MeanderWatermark } from "@/components/MeanderWatermark";
import { cn } from "@/lib/cn";

type Category = "all" | "index" | "treasury" | "meme";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "all", label: "All" },
  { id: "index", label: "Index" },
  { id: "treasury", label: "Treasury" },
  { id: "meme", label: "Meme" },
];

const WAD = 10n ** 18n;

export default function DiscoverPage() {
  const [sort, setSort] = useState<SortId>("ballasted");
  const [trendingView, setTrendingView] = useState(false);
  const [category, setCategory] = useState<Category>("all");
  const { projects, count, isLoading, isConfigured, hasLaunches } = useProjects();
  const trending = useTrending();

  const tokens = useMemo(() => projects.map((p) => p.token), [projects]);
  const holdersAgg = useProtocolHolders(tokens);

  // Per-token external metrics for the volume / holders sorts, from the SAME sources
  // the stats row and trending use — so an order and a headline never disagree.
  const volumeByToken = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of trending.data?.items ?? []) m.set(it.token.toLowerCase(), it.volume24hUsd);
    return m;
  }, [trending.data]);
  const holdersByToken = useMemo(() => {
    const c = holdersAgg.data.counts ?? {};
    return new Map(Object.entries(c).map(([k, v]) => [k.toLowerCase(), v]));
  }, [holdersAgg.data]);

  // The protocol token is PINNED, not ranked — pull it out and rank everything else
  // separately, so it never appears to have earned a spot in the sorted list.
  const protocolProject = useMemo(() => projects.find((p) => isProtocolToken(p.token)), [projects]);
  const ranked = useMemo(
    () => sortProjects(projects.filter((p) => !isProtocolToken(p.token)), sort, { volumeByToken, holdersByToken }),
    [projects, sort, volumeByToken, holdersByToken],
  );

  // Trending order comes from the /api/trending aggregation (unique buyers + 24h
  // volume). Map the ranked token list back onto our live projects, excluding the
  // pinned protocol token. Falls back to a notice when thin/unavailable below.
  const trendingRanked = useMemo(() => {
    const byToken = new Map(projects.map((p) => [p.token.toLowerCase(), p]));
    return (trending.data?.items ?? [])
      .map((it) => byToken.get(it.token.toLowerCase()))
      .filter((p): p is Project => Boolean(p) && !isProtocolToken(p!.token));
  }, [trending.data, projects]);

  // A wallet is "known" once it has launched before. First-time creators get an
  // amber note (spec §9) — a new wallet is UNKNOWN, not safe.
  const priorLaunches = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of projects) {
      const k = p.creator.toLowerCase();
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [projects]);

  // A chain-time sort shows launch-order, not a chart, on each card.
  const chainTimeSort = sort === "newest" || sort === "oldest";

  return (
    <div className="relative overflow-hidden">
      <MeanderWatermark />
      <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Discover</h1>

      {/* Stats row — four headline figures, Total ballast first. Derived from the
          SAME projects listed below, so the totals reconcile by construction. Hidden
          only when the app isn't configured (nothing to read). */}
      {isConfigured && (
        <div className="mt-5">
          <DiscoverStats projects={projects} count={count} isLoading={isLoading} />
        </div>
      )}

      {/* Protocol token — pinned ABOVE the featured strip, labelled as a placement,
          never inside the ranked strip below. */}
      {isConfigured && !isLoading && protocolProject && (
        <div className="mt-5">
          <PinnedProtocolCard project={protocolProject} />
        </div>
      )}

      {/* Featured strip — beneath the stats/pinned, above the rail. Ranked by locked
          backing; renders nothing until at least one ballasted project qualifies. */}
      {isConfigured && !isLoading && (
        <div className="mt-6">
          <FeaturedStrip projects={ranked} />
        </div>
      )}

      {/* Sort rail — chips for every order we can actually compute, plus the
          separate Trending state. The rule beneath the rail states how the current
          order is computed and from which source. */}
      <div className="mt-6">
        <SortRail sort={sort} onSort={setSort} trending={trendingView} onTrending={setTrendingView} />
      </div>

      {/* Category chips — a distinct SECOND row (leading label + pills) so a filter is
          never confused with a sort. Non-All filters need the indexer's category
          metadata. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs uppercase tracking-wide text-text-faint">Category</span>
        {CATEGORIES.map((c) => {
          const disabled = c.id !== "all"; // metadata pending indexer
          return (
            <button
              key={c.id}
              onClick={() => !disabled && setCategory(c.id)}
              disabled={disabled}
              title={disabled ? "Category filter pending indexer" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-sm",
                category === c.id ? "border-green bg-green-bg text-green" : "border-border text-text-muted",
                disabled && "cursor-not-allowed opacity-40",
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        {!isConfigured ? (
          <EmptyState
            title="Not configured yet"
            body="The factory and BackingLens addresses aren't set. Deploy the core contracts and set NEXT_PUBLIC_FACTORY_ADDRESS and NEXT_PUBLIC_LENS_ADDRESS, and Discover reads the registry live."
          />
        ) : isLoading ? (
          <SkeletonGrid />
        ) : !hasLaunches ? (
          <EmptyState
            title="Nothing has launched yet"
            body="The first projects appear here the moment a launch confirms on-chain. Ballasted — the default order — ranks them by verified treasury value locked forever, so a project's backing is the default, not an afterthought."
            action={
              <Link href="/app/create" className="btn-primary inline-block px-5">
                Create a launch
              </Link>
            }
          />
        ) : trendingView ? (
          // Trending is ranked by unique buyers + 24h volume (see /api/trending), so
          // wash-trading can't buy the top slot. When the data is thin or the source
          // is unreachable we SAY so, rather than show an unsorted list dressed as a
          // ranking (which reads identical to Ballasted and is quietly misleading).
          trending.isLoading ? (
            <SkeletonGrid />
          ) : !trending.available ? (
            <TrendingNotice reason="unreachable" />
          ) : trending.data?.thin || trendingRanked.length === 0 ? (
            <TrendingNotice reason="thin" />
          ) : (
            <div>
              <p className="mb-3 text-xs text-text-faint">
                Ranked by unique buyers, then 24h volume · GeckoTerminal
                {trending.data?.fetchedAt ? ` · updated ${formatEt(trending.data.fetchedAt)}` : ""}
              </p>
              <CardGrid
                projects={trendingRanked}
                priorLaunches={priorLaunches}
              />
            </div>
          )
        ) : sort === "volume" && trending.isLoading ? (
          <SkeletonGrid />
        ) : sort === "volume" && !trending.available ? (
          <SourceUnavailableNotice metric="24h volume" source="GeckoTerminal" />
        ) : sort === "holders" && holdersAgg.isLoading ? (
          <SkeletonGrid />
        ) : sort === "holders" && !holdersAgg.data.available ? (
          <SourceUnavailableNotice metric="holders" source="Blockscout" />
        ) : ranked.length === 0 ? (
          <EmptyState
            title="Only the protocol token so far"
            body="No other projects have launched yet. The next launch appears here — ranked by backing on Ballasted, by launch time on Newest and Oldest."
            action={
              <Link href="/app/create" className="btn-primary inline-block px-5">
                Create a launch
              </Link>
            }
          />
        ) : (
          <CardGrid projects={ranked} priorLaunches={priorLaunches} hideSparkline={chainTimeSort} />
        )}
      </div>
    </div>
  );
}

// Responsive card grid: 1 / 2 / 3 columns. At very low counts (1) the card is
// featured and centred rather than stranded small in a wide row (density §1).
function CardGrid({
  projects,
  priorLaunches,
  hideSparkline,
}: {
  projects: Project[];
  priorLaunches: Map<string, number>;
  hideSparkline?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        projects.length <= 1
          ? "mx-auto max-w-xl grid-cols-1"
          : projects.length === 2
            ? "sm:grid-cols-2"
            : "sm:grid-cols-2 lg:grid-cols-3",
      )}
    >
      {projects.map((p, i) => (
        <div key={p.token} className="anim-enter" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
          <ProjectCard
            project={p}
            hideSparkline={hideSparkline}
            firstLaunch={(priorLaunches.get(p.creator.toLowerCase()) ?? 0) <= 1}
            featured={projects.length <= 1}
          />
        </div>
      ))}
    </div>
  );
}

type SortCtx = { volumeByToken: Map<string, number>; holdersByToken: Map<string, number> };

function cmpBigDesc(a: bigint, b: bigint): number {
  return a > b ? -1 : a < b ? 1 : 0;
}

// Market cap = live pool price × supply, 1e18-scaled; 0 when there's no pool price.
// Uses the shared helper so the ordering here matches the market cap shown on the
// featured strip and on each token's page (spec 1.4 — one figure, one computation).
function marketCap1e18(p: Project): bigint {
  return marketCapUsd(p.marketPriceUsd, marketCapSupply(p.backing?.totalSupply)) ?? 0n;
}
// Backing ratio = market cap ÷ treasury value; -1 (sorts last) when unbacked.
function backingRatioOf(p: Project): number {
  const tv = p.backing?.totalValueUsd ?? 0n;
  if (tv === 0n) return -1;
  return Number((marketCap1e18(p) * WAD) / tv) / 1e18;
}

// Only orders computable from a real source (Phase 5). The registry is append-only,
// so its index order IS launch order (Oldest as-is, Newest reversed) — chain only,
// no indexer.
function sortProjects(projects: Project[], sort: SortId, ctx: SortCtx): Project[] {
  const copy = [...projects];
  switch (sort) {
    case "oldest":
      return copy;
    case "newest":
      return copy.reverse();
    case "mcap":
      return copy.sort((a, b) => cmpBigDesc(marketCap1e18(a), marketCap1e18(b)));
    case "ratio":
      return copy.sort((a, b) => backingRatioOf(b) - backingRatioOf(a));
    case "volume":
      return copy.sort(
        (a, b) =>
          (ctx.volumeByToken.get(b.token.toLowerCase()) ?? 0) - (ctx.volumeByToken.get(a.token.toLowerCase()) ?? 0),
      );
    case "holders":
      return copy.sort(
        (a, b) =>
          (ctx.holdersByToken.get(b.token.toLowerCase()) ?? 0) - (ctx.holdersByToken.get(a.token.toLowerCase()) ?? 0),
      );
    case "ballasted":
    default:
      // Ballasted first, then locked backing (the figure that cannot leave) descending.
      return copy.sort((a, b) => {
        if (a.ballasted !== b.ballasted) return a.ballasted ? -1 : 1;
        return cmpBigDesc(a.backing?.lockedValueUsd ?? 0n, b.backing?.lockedValueUsd ?? 0n);
      });
  }
}

// Trending is ranked honestly (unique buyers + 24h volume) from GeckoTerminal
// trades. When there isn't enough activity to rank, or the source is unreachable,
// we say so rather than re-sorting the same list into a fake ranking.
function TrendingNotice({ reason }: { reason: "thin" | "unreachable" }) {
  return (
    <div className="card p-10 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif text-lg font-semibold text-bone">
        {reason === "unreachable" ? "Trending is unavailable right now" : "Not enough trading to rank yet"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
        {reason === "unreachable"
          ? "GeckoTerminal, the trade-data source, didn't respond. Rather than show a stale or made-up order, trending is paused until it's reachable again."
          : "Trending ranks by unique buyers plus 24h volume, so two wallets trading with each other can't buy the top spot. There aren't enough real trades across launches yet to rank without it being noise — so we won't pretend."}
      </p>
      <p className="mx-auto mt-3 max-w-md text-xs text-text-faint">
        Meanwhile, Ballasted ranks by verified locked backing, and Newest by launch time — both live from the chain.
      </p>
    </div>
  );
}

// A sort backed by an external source we can't reach right now. We pause the order
// rather than silently fall back to another one (which would read as a measurement
// it isn't).
function SourceUnavailableNotice({ metric, source }: { metric: string; source: string }) {
  return (
    <div className="card p-10 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif text-lg font-semibold text-bone">Can’t sort by {metric} right now</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
        {source} didn’t respond, so this order can’t be computed. Rather than quietly fall back to another sort, it’s
        paused until {source} is reachable again.
      </p>
      <p className="mx-auto mt-3 max-w-md text-xs text-text-faint">
        The on-chain orders — Ballasted, Newest, Oldest, Market cap, Backing ratio — work regardless.
      </p>
    </div>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="card p-10 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif text-lg font-semibold text-bone">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// Skeleton mirrors ProjectCard's layout exactly, so nothing shifts when the real
// cards resolve (the biggest perceived-quality win for slow chain reads).
function SkeletonGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-surface-raised" />
              <div className="space-y-1.5">
                <div className="h-4 w-24 animate-pulse rounded bg-surface-raised" />
                <div className="h-3 w-32 animate-pulse rounded bg-surface-raised" />
              </div>
            </div>
            <div className="h-6 w-12 animate-pulse rounded bg-surface-raised" />
          </div>
          <div className="mt-3 border-t border-border pt-3">
            <div className="h-4 w-40 animate-pulse rounded bg-surface-raised" />
            <div className="mt-1.5 h-3 w-28 animate-pulse rounded bg-surface-raised" />
          </div>
        </div>
      ))}
    </div>
  );
}
