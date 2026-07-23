"use client";

import { useMemo, useState } from "react";
import { useProjects, type Project } from "@/hooks/useProjects";
import { ProjectCard } from "@/components/app/ProjectCard";
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
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Discover</h1>

      {/* Sort tabs — underline style. Ballasted is the default: the positioning
          is structural, not cosmetic. */}
      <div className="mt-4 flex gap-6 border-b border-border">
        {SORT_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSort(t.id)}
            className={cn(
              "relative -mb-px border-b-2 pb-2.5 text-sm",
              sort === t.id
                ? "border-green text-text-primary"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {t.label}
          </button>
        ))}
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
          <div className="grid gap-3 sm:grid-cols-2">
            {sorted.map((p) => (
              <ProjectCard
                key={p.token}
                project={p}
                hideSparkline={sort === "new"}
                firstLaunch={(priorLaunches.get(p.creator.toLowerCase()) ?? 0) <= 1}
              />
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
      <h2 className="font-semibold text-text-primary">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card h-28 animate-pulse p-4">
          <div className="h-10 w-10 rounded-full bg-border" />
        </div>
      ))}
    </div>
  );
}
