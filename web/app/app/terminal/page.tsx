"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Address } from "viem";
import { useProjects, type Project } from "@/hooks/useProjects";
import { useProjectsMeta } from "@/hooks/useProjectMeta";
import { Logo } from "@/components/app/Logo";
import { ipfsToGateway } from "@/lib/ipfs";
import { formatBackingPerToken, shortAddress } from "@/lib/format";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";

// TERMINAL INDEX — the terminal is per-token (/app/terminal/[address]), so a global
// nav entry needs somewhere to land: this picker. It lists every launch and lets you
// search by name/ticker or paste an address, then routes into that token's terminal —
// so the dense trading view is reachable directly from the nav, not only via a token
// page's "Open in terminal" link. Same registry + live reads as Discover (useProjects),
// so the two boards never disagree.
export default function TerminalIndexPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const { projects, isLoading, isConfigured, hasLaunches } = useProjects();
  const metaByToken = useProjectsMeta(projects);

  const trimmed = q.trim();
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(trimmed);

  // Filter by ticker, name, or address. A full pasted address matches its own row
  // too, so the list narrows to it before the user even hits Open.
  const filtered = useMemo(() => {
    const s = trimmed.toLowerCase();
    if (!s) return projects;
    return projects.filter(
      (p) =>
        p.token.toLowerCase().includes(s) ||
        (p.symbol ?? "").toLowerCase().includes(s) ||
        (p.name ?? "").toLowerCase().includes(s),
    );
  }, [projects, trimmed]);

  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Terminal</h1>
      <p className="mt-2 max-w-prose text-sm text-text-muted">
        The dense, per-token trading view — candles, an order rail, treasury, trades and holders in one screen. Pick a
        token below, or paste its address, to open its terminal.
      </p>

      {/* Search / paste-address bar. A valid address enables Open (and Enter routes
          straight there), so a token you already know needs no scrolling. */}
      <form
        className="mt-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (isAddr) router.push(`/app/terminal/${trimmed as Address}`);
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, ticker, or paste a token address"
          className="input flex-1"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search tokens or paste a token address"
        />
        <button type="submit" disabled={!isAddr} className="btn-primary px-5">
          Open
        </button>
      </form>

      <div className="mt-5">
        {!isConfigured ? (
          <Empty
            title="Not configured yet"
            body="The factory and BackingLens addresses aren't set, so there are no launches to open a terminal for."
          />
        ) : isLoading ? (
          <SkeletonList />
        ) : !hasLaunches ? (
          <Empty
            title="Nothing has launched yet"
            body="The terminal opens per token. The first launch appears here the moment it confirms on-chain."
            action={
              <Link href="/app/create" className="btn-primary inline-block px-5">
                Create a launch
              </Link>
            }
          />
        ) : filtered.length === 0 ? (
          <Empty
            title="No match"
            body={`Nothing matches "${trimmed}". Clear the search to see every launch${isAddr ? ", or press Open to go straight to that address." : "."}`}
          />
        ) : (
          <ul className="space-y-2">
            {filtered.map((p) => (
              <li key={p.token}>
                <TokenRow p={p} logo={ipfsToGateway(metaByToken.get(p.token.toLowerCase())?.logo)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TokenRow({ p, logo }: { p: Project; logo?: string }) {
  const price = p.marketPriceUsd !== undefined ? formatBackingPerToken(p.marketPriceUsd) : "—";
  return (
    <Link href={`/app/terminal/${p.token}`} className="card card-hover flex items-center gap-3 p-3">
      <Logo src={logo} symbol={p.symbol} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-text-primary">{p.symbol ?? shortAddress(p.token)}</span>
          {p.ballasted && <span className="chip chip-accent">Ballasted</span>}
        </div>
        <span className="block truncate text-xs text-text-muted">{p.name ?? "Unnamed project"}</span>
      </div>
      <div className="shrink-0 text-right">
        <span className="block text-sm tabular-nums text-text-primary">{price}</span>
        <span className="eyebrow">Price</span>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0 text-text-faint">
        <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Link>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="card p-10 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif text-lg font-semibold text-bone">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// Skeleton mirrors TokenRow's layout exactly, so the list doesn't shift when the
// chain reads land.
function SkeletonList() {
  return (
    <ul className="space-y-2" aria-hidden>
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className="card flex items-center gap-3 p-3">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-surface-raised" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-4 w-24 animate-pulse rounded bg-surface-raised" />
            <div className="h-3 w-40 animate-pulse rounded bg-surface-raised" />
          </div>
          <div className="h-4 w-16 animate-pulse rounded bg-surface-raised" />
        </li>
      ))}
    </ul>
  );
}
