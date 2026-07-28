"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useProjects, type Project } from "@/hooks/useProjects";
import { ProjectCard } from "@/components/app/ProjectCard";
import { PinnedProtocolCard } from "@/components/app/PinnedProtocolCard";
import { isProtocolToken } from "@/components/app/token/ProtocolTokenNotice";
import { Meander } from "@/components/Meander";
import { MeanderWatermark } from "@/components/MeanderWatermark";
import { cn } from "@/lib/cn";

type SortTab = "ballasted" | "trending" | "new";
type Category = "all" | "index" | "treasury" | "meme";

const SORT_TABS: { id: SortTab; label: string }[] = [
  { id: "ballasted", label: "Ballasted" },
  { id: "trending", label: "Trending" },
  { id: "new", label: "New" },
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

  // The protocol token is PINNED, not ranked — pull it out and rank everything else
  // separately, so it never appears to have earned a spot in the sorted list.
  const protocolProject = useMemo(() => projects.find((p) => isProtocolToken(p.token)), [projects]);
  const ranked = useMemo(
    () => sortProjects(projects.filter((p) => !isProtocolToken(p.token)), sort),
    [projects, sort],
  );

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
    <div className="relative overflow-hidden">
      <MeanderWatermark />
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

      {/* Pinned protocol token — top of Discover, on every tab and filter, visually
          distinct from and excluded from the ranked list below (a placement, not a
          ranking result). */}
      {isConfigured && !isLoading && protocolProject && (
        <div className="mt-5">
          <PinnedProtocolCard project={protocolProject} />
        </div>
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
            title="Nothing has launched yet"
            body="The first projects appear here the moment a launch confirms on-chain. The Ballasted tab ranks them by verified treasury value locked forever — a project's backing is the default order, not an afterthought."
            action={
              <Link href="/app/create" className="btn-primary inline-block px-5">
                Create a launch
              </Link>
            }
          />
        ) : sort === "trending" ? (
          // Trending needs trade data we don't have yet — so say that, rather than
          // showing an unsorted list dressed up as a ranking (which reads identical
          // to Ballasted and is quietly misleading).
          <TrendingNotice />
        ) : ranked.length === 0 ? (
          <EmptyState
            title="Only the protocol token so far"
            body="No other projects have launched yet. The next launch appears here, ranked by backing on Ballasted and by launch time on New."
            action={
              <Link href="/app/create" className="btn-primary inline-block px-5">
                Create a launch
              </Link>
            }
          />
        ) : (
          // Responsive grid: 1 / 2 / 3 columns. At very low counts (1) the card is
          // featured and centred rather than stranded small in a wide row (§1).
          <div
            key={sort}
            className={cn(
              "grid gap-4",
              ranked.length <= 1
                ? "mx-auto max-w-xl grid-cols-1"
                : ranked.length === 2
                  ? "sm:grid-cols-2"
                  : "sm:grid-cols-2 lg:grid-cols-3",
            )}
          >
            {ranked.map((p, i) => (
              <div key={p.token} className="anim-enter" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                <ProjectCard
                  project={p}
                  hideSparkline={sort === "new"}
                  firstLaunch={(priorLaunches.get(p.creator.toLowerCase()) ?? 0) <= 1}
                  featured={ranked.length <= 1}
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
  if (sort === "new") {
    // The factory registry is append-only, so its index order IS launch order.
    // Newest-first = reverse. Computable from chain alone — no indexer needed.
    return copy.reverse();
  }
  // "ballasted" (default): ballasted first, then locked backing (the figure that
  // cannot leave) descending. "trending" never reaches here — it renders a notice.
  return copy.sort((a, b) => {
    if (a.ballasted !== b.ballasted) return a.ballasted ? -1 : 1;
    const al = a.backing?.lockedValueUsd ?? 0n;
    const bl = b.backing?.lockedValueUsd ?? 0n;
    return bl > al ? 1 : bl < al ? -1 : 0;
  });
}

// Trending is intentionally not faked. It requires trade data — volume AND unique
// buyers — that neither the chain (at read speed) nor a wired indexer gives us yet.
// Ranking on volume alone would let two wallets wash-trade into the top slot, so
// when we build it, it ranks on unique buyers + volume. Until then we say so.
function TrendingNotice() {
  return (
    <div className="card p-10 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif text-lg font-semibold text-bone">Trending isn&apos;t live yet</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
        Trending needs trade data — volume and the number of distinct buyers — which comes from the indexer, not wired
        yet. We won&apos;t fake it by re-sorting the same list, because that reads as a ranking it hasn&apos;t earned.
        When it&apos;s live it ranks on unique buyers plus volume, so two wallets trading with each other can&apos;t buy
        the top spot.
      </p>
      <p className="mx-auto mt-3 max-w-md text-xs text-text-faint">
        Meanwhile, Ballasted ranks by verified locked backing, and New by launch time — both live from the chain.
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
