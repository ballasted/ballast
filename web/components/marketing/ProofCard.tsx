"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AssetDisc } from "@/components/app/AssetDisc";
import { KeelMark } from "@/components/Wordmark";
import { formatBackingPerToken } from "@/lib/format";
import type { ProofLaunch } from "@/app/api/proof-launches/route";

// Landing-hero proof card — the headline ("see exactly how much backs each
// token, live") made literally true on screen, not just asserted. No wagmi
// here: AssetDisc/format helpers are pure, and this only ever does a plain
// fetch() against our own API route, so the marketing bundle stays web3-free
// (same constraint as lib/heroStats.ts).
//
// Never shows a placeholder or hardcoded example — an empty/failed fetch
// renders the keel mark large and centered instead of a fake row.

const ROTATE_MS = 6_000;
const POLL_MS = 30_000;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function ProofCard() {
  const [launches, setLaunches] = useState<ProofLaunch[] | undefined>(undefined);
  const [fetchedAt, setFetchedAt] = useState<number | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [nowS, setNowS] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    async function poll() {
      try {
        const res = await fetch("/api/proof-launches", { cache: "no-store" });
        const json = (await res.json()) as { fetchedAt: number; launches: ProofLaunch[] };
        if (!mounted.current) return;
        setLaunches(json.launches);
        setFetchedAt(json.fetchedAt);
        setIndex((i) => (json.launches.length > 0 ? i % json.launches.length : 0));
      } catch {
        if (mounted.current) setLaunches((prev) => prev ?? []); // treat a failed fetch as "nothing resolved", never a guess
      }
    }
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, []);

  // Client-side "Xs ago" ticker — independent of the poll interval, ticks every
  // second so the freshness readout is honest between polls, not just at them.
  useEffect(() => {
    setNowS(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (reducedMotion || paused || !launches || launches.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % launches.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [reducedMotion, paused, launches]);

  if (launches === undefined) {
    // First load, before the API has answered at all — hold the brand anchor,
    // never a skeleton row pretending to be real data.
    return (
      <div className="flex h-40 w-full max-w-sm items-center justify-center">
        <KeelMark size={40} className="opacity-40" />
      </div>
    );
  }

  if (launches.length === 0) {
    return (
      <div className="flex h-40 w-full max-w-sm items-center justify-center">
        <KeelMark size={48} />
      </div>
    );
  }

  const l = launches[index % launches.length]!;
  const ageS = fetchedAt !== undefined && l.updatedAtAgeSeconds !== undefined ? l.updatedAtAgeSeconds + Math.max(0, nowS - fetchedAt) : undefined;
  const pollAgeS = fetchedAt !== undefined ? Math.max(0, nowS - fetchedAt) : undefined;

  return (
    <Link
      href={`/app/token/${l.token}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="card block w-full max-w-sm p-4 text-left transition-colors hover:border-text-faint"
    >
      <div key={l.token} className="anim-fade flex items-center gap-3">
        <AssetDisc symbol={l.symbol} size={40} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-text-primary">{l.symbol}</div>
          <div className="truncate text-xs text-text-muted">{l.name}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        <span className="flex items-center gap-1.5 text-text-secondary">
          <span className="text-text-faint">Backed by</span>
          {l.backedBySymbol ? (
            <>
              <AssetDisc identity={{ status: "recognized", symbol: l.backedBySymbol }} size={16} />
              {l.backedBySymbol}
            </>
          ) : (
            <span className="text-text-faint">No deposit</span>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-text-secondary">
          <span className="text-text-faint">Pool</span>
          {l.quoteAssetSymbols.map((s) => (
            <span key={s} className="flex items-center gap-1">
              <AssetDisc identity={{ status: "recognized", symbol: s }} size={16} />
              {s}
            </span>
          ))}
        </span>
      </div>

      <div className="mt-3 flex items-baseline justify-between">
        <span className="figure-primary text-lg">{formatBackingPerToken(BigInt(l.backingPerTokenUsd))}</span>
        <span className="metric-secondary">backing per token</span>
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-text-faint">
        <span>{ageS !== undefined ? `Chainlink updated ${formatAge(ageS)} ago` : "Unbacked"}</span>
        <span>read from chain · {pollAgeS !== undefined ? formatAge(pollAgeS) : "…"} ago</span>
      </div>
    </Link>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
