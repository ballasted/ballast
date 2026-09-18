"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { useProjects, type Project } from "@/hooks/useProjects";
import { useTrending } from "@/hooks/useTrending";
import { ProjectCard } from "@/components/app/ProjectCard";
import { DiscoverStats } from "@/components/app/DiscoverStats";
import { MotionSection } from "@/components/app/MotionSection";
import { SortRail, type SortId, type FilterId } from "@/components/app/SortRail";
import { PromoBanners } from "@/components/app/PromoBanners";
import { LiveRail } from "@/components/app/LiveRail";
import { TopMovers } from "@/components/app/TopMovers";
import { PinnedProtocolCard } from "@/components/app/PinnedProtocolCard";
import { isProtocolToken } from "@/components/app/token/ProtocolTokenNotice";
import { marketCapUsd, marketCapSupply } from "@/lib/market";
import { MeanderWatermark } from "@/components/MeanderWatermark";
import { cn } from "@/lib/cn";

const PAGE_SIZE = 20;

export default function DiscoverPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [sort, setSort] = useState<SortId>("backing");
  const [filter, setFilter] = useState<FilterId>("all");

  // Plain useState + a read-on-mount effect rather than useSearchParams, which
  // would force this statically-prerendered page into a Suspense boundary —
  // this page is already fully client-rendered, so there's nothing SSR needs
  // to see here.
  const [page, setPageState] = useState(1);
  useEffect(() => {
    const p = parseInt(new URLSearchParams(window.location.search).get("page") ?? "1", 10);
    if (Number.isFinite(p) && p > 1) setPageState(p);
  }, []);
  const setPage = (p: number) => {
    setPageState(p);
    const params = new URLSearchParams(window.location.search);
    if (p <= 1) params.delete("page");
    else params.set("page", String(p));
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  // Any filter/sort change invalidates the current page — a stale page number
  // could point past the end of the new, shorter list. Skips the mount-time
  // run, which would otherwise stomp a deep-linked ?page= before the
  // read-on-mount effect above even gets a chance to apply it.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, filter]);
  const { projects, count, isLoading, isConfigured, hasLaunches } = useProjects();
  const trending = useTrending();

  // Per-token 24h volume, from the SAME source the stats row uses — so an
  // order and a headline never disagree.
  const volumeByToken = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of trending.data?.items ?? []) m.set(it.token.toLowerCase(), it.volume24hUsd);
    return m;
  }, [trending.data]);

  // The protocol token is PINNED, not ranked — pull it out and rank everything
  // else separately, so it never appears to have earned a spot in the list.
  const protocolProject = useMemo(() => projects.find((p) => isProtocolToken(p.token)), [projects]);

  const matchesFilter = (p: Project) => {
    if (filter === "all") return true;
    if (filter === "ballasted") return p.ballasted;
    return filter === "graduated" ? p.hasPool : !p.hasPool;
  };

  const ranked = useMemo(
    () => sortProjects(projects.filter((p) => !isProtocolToken(p.token) && matchesFilter(p)), sort, volumeByToken),
    [projects, sort, filter, volumeByToken],
  );

  return (
    <div className="relative overflow-hidden">
      <MeanderWatermark />

      <PromoBanners />

      {/* Live rail sits at xl+ only, beside the main column — a narrower
          viewport has no room for a third column alongside the card grid. */}
      <div className="xl:grid xl:grid-cols-[1fr_320px] xl:items-start xl:gap-6">
      <div className="min-w-0">

      {isConfigured && (
        <MotionSection className="mt-5">
          <DiscoverStats projects={projects} count={count} isLoading={isLoading} />
        </MotionSection>
      )}

      {isConfigured && !isLoading && protocolProject && (
        <div className="mt-5">
          <PinnedProtocolCard project={protocolProject} />
        </div>
      )}

      <div className="mt-6">
        <SortRail sort={sort} onSort={setSort} filter={filter} onFilter={setFilter} />
      </div>

      <div className="mt-5">
        {!isConfigured ? (
          <EmptyState title="Not configured yet" />
        ) : isLoading ? (
          <SkeletonGrid />
        ) : !hasLaunches ? (
          <EmptyState
            title="Nothing yet."
            action={
              <Link href="/app/create" className="btn-primary inline-block px-5">
                Create a launch
              </Link>
            }
          />
        ) : sort === "volume" && trending.isLoading ? (
          <SkeletonGrid />
        ) : sort === "volume" && !trending.available ? (
          <EmptyState title="24h volume unavailable" />
        ) : ranked.length === 0 ? (
          <EmptyState title="Nothing yet." />
        ) : (
          <>
            <CardGrid projects={ranked.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)} />
            <Pagination page={page} totalPages={Math.ceil(ranked.length / PAGE_SIZE)} onPage={setPage} />
          </>
        )}
      </div>

      </div>

      {isConfigured && (
        <aside className="mt-6 hidden space-y-4 xl:sticky xl:top-20 xl:mt-0 xl:block">
          <LiveRail projects={projects} />
          <TopMovers projects={projects} />
        </aside>
      )}
      </div>
    </div>
  );
}

// Page numbers, URL-synced. Collapses to a short window around the current
// page plus the first/last, so a 40-page list doesn't render 40 buttons.
function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  const keep = new Set<number>([1, totalPages, page, page - 1, page + 1].filter((p) => p >= 1 && p <= totalPages));
  const pages = [...keep].sort((a, b) => a - b);

  const items: React.ReactNode[] = [];
  let prev = 0;
  for (const p of pages) {
    if (prev && p - prev > 1) items.push(<span key={`gap-${p}`} className="px-1 text-text-faint">…</span>);
    items.push(
      <button
        key={p}
        onClick={() => onPage(p)}
        aria-current={p === page ? "page" : undefined}
        className={cn(
          "h-8 min-w-8 rounded-input px-2 text-sm tabular-nums transition-colors",
          p === page ? "bg-green text-bg font-semibold" : "text-text-muted hover:bg-surface-raised hover:text-text-secondary",
        )}
      >
        {p}
      </button>,
    );
    prev = p;
  }

  return (
    <nav aria-label="Discover pages" className="mt-6 flex items-center justify-center gap-1">
      <button
        onClick={() => onPage(Math.max(1, page - 1))}
        disabled={page <= 1}
        aria-label="Previous page"
        className="h-8 rounded-input px-2 text-sm text-text-muted transition-colors hover:bg-surface-raised disabled:opacity-30"
      >
        ‹
      </button>
      {items}
      <button
        onClick={() => onPage(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        aria-label="Next page"
        className="h-8 rounded-input px-2 text-sm text-text-muted transition-colors hover:bg-surface-raised disabled:opacity-30"
      >
        ›
      </button>
    </nav>
  );
}

// One grid, one card, for every token — 4/3/2/1 columns at xl/lg/md/sm, equal
// heights (UI principles §5).
function CardGrid({ projects }: { projects: Project[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {projects.map((p, i) => (
        <div key={p.token} className="anim-enter" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
          <ProjectCard project={p} />
        </div>
      ))}
    </div>
  );
}

// Market cap = live pool price × supply, 1e18-scaled; 0 when there's no pool
// price. Shared helper so the sort order matches the market cap shown on the
// card and on the token page (one figure, one computation).
function marketCap1e18(p: Project): bigint {
  return marketCapUsd(p.marketPriceUsd, marketCapSupply(p.backing?.totalSupply)) ?? 0n;
}

function cmpBigDesc(a: bigint, b: bigint): number {
  return a > b ? -1 : a < b ? 1 : 0;
}

// Only orders computable from a real source. The registry is append-only, so
// its index order IS launch order (Newest is just the reverse) — chain only,
// no indexer.
function sortProjects(projects: Project[], sort: SortId, volumeByToken: Map<string, number>): Project[] {
  const copy = [...projects];
  switch (sort) {
    case "newest":
      return copy.reverse();
    case "mcap":
      return copy.sort((a, b) => cmpBigDesc(marketCap1e18(a), marketCap1e18(b)));
    case "volume":
      return copy.sort(
        (a, b) => (volumeByToken.get(b.token.toLowerCase()) ?? 0) - (volumeByToken.get(a.token.toLowerCase()) ?? 0),
      );
    case "backing":
    default:
      // Ballasted first, then locked backing (the figure that cannot leave) descending.
      return copy.sort((a, b) => {
        if (a.ballasted !== b.ballasted) return a.ballasted ? -1 : 1;
        return cmpBigDesc(a.backing?.lockedValueUsd ?? 0n, b.backing?.lockedValueUsd ?? 0n);
      });
  }
}

function EmptyState({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="card p-10 text-center">
      <h2 className="font-serif text-lg font-semibold text-bone">{title}</h2>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// Skeleton mirrors ProjectCard's layout exactly, so nothing shifts when the
// real cards resolve.
function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="card overflow-hidden">
          <div className="aspect-square w-full animate-pulse bg-surface-raised" />
          <div className="p-4">
            <div className="h-4 w-24 animate-pulse rounded bg-surface-raised" />
            <div className="mt-1.5 h-3 w-32 animate-pulse rounded bg-surface-raised" />
            <div className="mt-3 h-5 w-20 animate-pulse rounded bg-surface-raised" />
            <div className="mt-4 flex justify-between">
              <div className="h-5 w-24 animate-pulse rounded-full bg-surface-raised" />
              <div className="h-5 w-16 animate-pulse rounded-full bg-surface-raised" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
