"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useProjects, type Project } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useDenylist } from "@/hooks/useDenylist";
import { useBasketHistory } from "@/hooks/useBasketHistory";
import { useRamsesPosition } from "@/hooks/useRamsesPosition";
import { AssetDisc } from "@/components/app/AssetDisc";
import { MotionSection } from "@/components/app/MotionSection";
import { ipfsToGateway } from "@/lib/ipfs";
import { formatUsd, shortAddress } from "@/lib/format";
import { isBasketEnabled } from "@/lib/contracts";
import { cn } from "@/lib/cn";

// The nav entry for every token's treasury — same role Discover plays for
// price/volume, but keyed on backing instead. Lists only ballasted tokens
// (an unbacked launch has nothing to show here); each row links to its own
// full backing page (/app/backing/[address]).
export default function BackingIndexPage() {
  const { projects, isLoading } = useProjects();
  const [query, setQuery] = useState("");

  const ballasted = useMemo(() => projects.filter((p) => p.ballasted), [projects]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ballasted;
    return ballasted.filter((p) => (p.symbol ?? "").toLowerCase().includes(q) || (p.name ?? "").toLowerCase().includes(q));
  }, [ballasted, query]);

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => Number((b.backing?.totalValueUsd ?? 0n) - (a.backing?.totalValueUsd ?? 0n))),
    [filtered],
  );

  return (
    <div className="space-y-5">
      <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Backing</h1>

      <input
        className="input max-w-sm"
        placeholder="Search by ticker or name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {isLoading ? (
        <SkeletonGrid />
      ) : sorted.length === 0 ? (
        <div className="card p-6 text-center text-sm text-text-muted">
          {ballasted.length === 0 ? "No launch has a treasury yet." : "No match."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {sorted.map((p) => (
            <MotionSection key={p.token}>
              <BackingIndexCard project={p} />
            </MotionSection>
          ))}
        </div>
      )}
    </div>
  );
}

function BackingIndexCard({ project }: { project: Project }) {
  const { symbol, name, backing, token } = project;
  const { meta } = useProjectMeta(project.metadataURI);
  const { isDenied } = useDenylist();
  const denied = isDenied(token);
  const logo = ipfsToGateway(denied ? undefined : meta?.logo);

  const basket = useBasketHistory(token);
  const ramses = useRamsesPosition(token);

  return (
    <Link href={`/app/backing/${token}`} className="card card-hover flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <AssetDisc src={logo} symbol={symbol} size={40} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-text-primary">{symbol ?? shortAddress(token)}</div>
          <div className="truncate text-sm text-text-muted">{denied ? "Metadata withheld" : (name ?? shortAddress(token))}</div>
        </div>
      </div>

      <div>
        <div className="eyebrow">Treasury</div>
        <div className="figure-primary text-xl tabular-nums">{formatUsd(backing?.totalValueUsd ?? 0n, { compact: true })}</div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {isBasketEnabled && <span className={cn("chip", basket.hasHistory ? "chip-accent" : "chip-neutral")}>{basket.hasHistory ? "Basket" : "No basket"}</span>}
        {ramses.position && <span className="chip chip-accent">Ramses locked</span>}
      </div>
    </Link>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="card h-32 animate-pulse p-4" />
      ))}
    </div>
  );
}
