"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useProjects, type Project } from "@/hooks/useProjects";
import { useProjectsMeta } from "@/hooks/useProjectMeta";
import { AssetDisc } from "@/components/app/AssetDisc";
import { ipfsToGateway } from "@/lib/ipfs";
import { shortAddress } from "@/lib/format";
import { marketCapUsd, marketCapSupply, formatCompactUsd } from "@/lib/market";
import { cn } from "@/lib/cn";

const MAX_RESULTS = 8;

// ⌘K / Ctrl+K command search (spec §4, App shell). Tokens only — searched
// client-side against the SAME useProjects registry Discover/Terminal use, so
// results never disagree with what's actually launched. There is no trader
// or handle directory anywhere in this app (no indexer), so unlike the spec's
// mock-up this does not attempt a "traders" result group — inventing one
// would mean fabricating a search index that doesn't exist.
export function CommandSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const { projects, isLoading, isConfigured } = useProjects();
  const metaByToken = useProjectsMeta(projects);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const scored = (s ? projects.filter((p) => matches(p, s)) : projects).map((p) => ({
      project: p,
      rank: s ? rankOf(p, s) : 0,
    }));
    scored.sort((a, b) => a.rank - b.rank);
    return scored.slice(0, MAX_RESULTS).map((r) => r.project);
  }, [projects, q]);

  useEffect(() => setActiveIndex(0), [q, open]);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
  }, []);

  const go = useCallback(
    (p: Project) => {
      close();
      router.push(`/app/token/${p.token}`);
    },
    [close, router],
  );

  // Global hotkey: Cmd/Ctrl+K opens from anywhere; Escape closes while open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === "Escape" && open) {
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-pill border border-border bg-card px-3 py-1.5 text-sm text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary"
        aria-label="Search tokens (Cmd+K)"
      >
        <IconSearch />
        <span className="hidden sm:inline">Search tokens…</span>
        <kbd className="hidden rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-faint sm:inline">
          ⌘K
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[70] flex items-start justify-center bg-black/70 p-4 pt-[12vh]"
          role="dialog"
          aria-modal="true"
          aria-label="Search tokens"
          onClick={close}
        >
          <div className="card-raised w-full max-w-lg p-0" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <IconSearch className="text-text-faint" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name, ticker, or paste a token address"
                spellCheck={false}
                autoComplete="off"
                aria-label="Search tokens or paste a token address"
                className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-faint focus:outline-none"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveIndex((i) => Math.min(i + 1, results.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveIndex((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const picked = results[activeIndex];
                    if (picked) go(picked);
                  }
                }}
              />
              <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-faint">Esc</kbd>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-2">
              {!isConfigured ? (
                <EmptyRow text="Not configured yet — no launches to search." />
              ) : isLoading ? (
                <EmptyRow text="Loading launches…" />
              ) : results.length === 0 ? (
                <EmptyRow text={q.trim() ? `No tokens match “${q.trim()}”.` : "No launches yet."} />
              ) : (
                results.map((p, i) => (
                  <ResultRow
                    key={p.token}
                    p={p}
                    logo={ipfsToGateway(metaByToken.get(p.token.toLowerCase())?.logo)}
                    active={i === activeIndex}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => go(p)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function matches(p: Project, s: string): boolean {
  return (
    p.token.toLowerCase().includes(s) ||
    (p.symbol ?? "").toLowerCase().includes(s) ||
    (p.name ?? "").toLowerCase().includes(s)
  );
}

// Lower rank sorts first: exact ticker match, then ticker prefix, then any
// substring hit elsewhere (name or address).
function rankOf(p: Project, s: string): number {
  const symbol = (p.symbol ?? "").toLowerCase();
  if (symbol === s) return 0;
  if (symbol.startsWith(s)) return 1;
  if (symbol.includes(s)) return 2;
  if ((p.name ?? "").toLowerCase().includes(s)) return 3;
  return 4;
}

function ResultRow({
  p,
  logo,
  active,
  onMouseEnter,
  onClick,
}: {
  p: Project;
  logo?: string;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  const cap = p.marketPriceUsd !== undefined ? marketCapUsd(p.marketPriceUsd, marketCapSupply(p.backing?.totalSupply)) : undefined;
  const capLabel = cap !== undefined ? formatCompactUsd(Number(cap) / 1e18) : p.ballasted ? "Not priced" : "Not ballasted";
  return (
    <button
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-input p-2.5 text-left transition-colors",
        active ? "bg-surface-hover" : "hover:bg-surface-raised",
      )}
    >
      <AssetDisc src={logo} symbol={p.symbol} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-text-primary">{p.symbol ?? shortAddress(p.token)}</span>
          {p.ballasted && <span className="chip chip-accent">Ballasted</span>}
        </div>
        <span className="block truncate text-xs text-text-muted">{p.name ?? shortAddress(p.token)}</span>
      </div>
      <span className="shrink-0 font-mono text-xs tabular-nums text-text-muted">{capLabel}</span>
    </button>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="p-4 text-center text-sm text-text-muted">{text}</p>;
}

function IconSearch({ className }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
