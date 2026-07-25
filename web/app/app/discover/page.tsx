"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useProjects, type Project } from "@/hooks/useProjects";
import { ProjectCard } from "@/components/app/ProjectCard";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";

type SortTab = "ballasted" | "trending" | "new";
type Category = "all" | "index" | "treasury" | "meme";

const SORT_TABS: { id: SortTab; label: string; pendingIndexer?: boolean }[] = [
  { id: "ballasted", label: "Ballasted" },
  { id: "trending", label: "Trending", pendingIndexer: true },
  { id: "new", label: "New", pendingIndexer: true },
];

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "all", label: "All" },
  { id: "index", label: "Index" },
  { id: "treasury", label: "Treasury" },
  { id: "meme", label: "Meme" },
];

export default function DiscoverPage() {
  const [sort, setSort] = useState<SortTab>("ballasted");
  const [category, setCategory] = useState<Category>("all");
  const { projects, isLoading, isConfigured, hasLaunches } = useProjects();

  // Sliding tab underline — one element that translates between tabs, rather than
  // a border flicking on/off (Phase 3). Position is measured from the active
  // button; the CSS transition does the slide, and motion-reduce disables it.
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  useEffect(() => {
    const el = tabRefs.current[sort];
    if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
  }, [sort]);

  const sorted = useMemo(() => sortProjects(projects, sort), [projects, sort]);

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

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Discover</h1>

      {/* Sort tabs — underline style. Ballasted is the default: the positioning
          is structural, not cosmetic. The green underline slides between tabs. */}
      <div className="relative mt-4 flex gap-6 border-b border-border">
        {SORT_TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            onClick={() => setSort(t.id)}
            className={cn(
              "pb-2.5 text-sm transition-colors duration-150",
              sort === t.id ? "text-text-primary" : "text-text-muted hover:text-text-secondary",
            )}
          >
            {t.label}
          </button>
        ))}
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-px h-0.5 bg-green transition-all duration-200 ease-out motion-reduce:transition-none"
          style={{ left: indicator.left, width: indicator.width }}
        />
      </div>

      {/* Category chips — pill style. Distinct shape from tabs so sort and filter
          are never confused. Non-All filters need the indexer's category metadata. */}
      <div className="mt-4 flex flex-wrap gap-2">
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
                category === c.id
                  ? "border-green bg-green-bg text-green"
                  : "border-border text-text-muted",
                disabled && "cursor-not-allowed opacity-40",
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {sort !== "ballasted" && (
        <p className="mt-4 rounded-card border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning">
          {sort === "trending"
            ? "Trending ranking needs trade volume from the indexer — not wired yet. Showing all projects by backing."
            : "New-launch ordering and elapsed time need the indexer — not wired yet."}
        </p>
      )}

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
            title="No projects have launched yet"
            body="Nothing has been launched on this network. Be the first — Create a project, and it appears here the moment the launch confirms on-chain."
          />
        ) : sorted.length === 0 ? (
          <EmptyState title="Nothing here" body="No projects match this view." />
        ) : (
          <div key={sort} className="grid gap-3 sm:grid-cols-2">
            {sorted.map((p, i) => (
              <div key={p.token} className="anim-enter" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                <ProjectCard
                  project={p}
                  hideSparkline={sort === "new"}
                  firstLaunch={(priorLaunches.get(p.creator.toLowerCase()) ?? 0) <= 1}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function sortProjects(projects: Project[], sort: SortTab): Project[] {
  const copy = [...projects];
  if (sort === "ballasted") {
    // Ballasted first, ranked by locked backing (the figure that cannot leave).
    return copy.sort((a, b) => {
      if (a.ballasted !== b.ballasted) return a.ballasted ? -1 : 1;
      const al = a.backing?.lockedValueUsd ?? 0n;
      const bl = b.backing?.lockedValueUsd ?? 0n;
      return bl > al ? 1 : bl < al ? -1 : 0;
    });
  }
  if (sort === "trending") {
    return copy.sort((a, b) => {
      const av = a.backing?.totalValueUsd ?? 0n;
      const bv = b.backing?.totalValueUsd ?? 0n;
      return bv > av ? 1 : bv < av ? -1 : 0;
    });
  }
  return copy; // "new" — preserve source order until the indexer provides timestamps
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif font-semibold text-bone">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}

// Skeleton mirrors ProjectCard's layout exactly, so nothing shifts when the real
// cards resolve (Phase 3 — the biggest perceived-quality win for slow chain reads).
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
