"use client";

import Link from "next/link";
import type { Project } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { ipfsToGateway } from "@/lib/ipfs";
import { Logo } from "@/components/app/Logo";
import { Meander } from "@/components/Meander";
import { formatSmallUsd } from "@/lib/market";
import { shortAddress } from "@/lib/format";

// The protocol token ($BALLAST), pinned to the top of Discover. Deliberately
// different IN KIND from the ranked cards below — raised surface, brighter accent
// ring, the meander mark, a serif bone name — so it's obviously a placement, not a
// card that climbed the ranking. The label says "Protocol token · pinned by
// BALLAST", never a merit badge: we don't vouch for anyone, so our own token being
// first must read as us putting it there, not as a result it earned.
export function PinnedProtocolCard({ project }: { project: Project }) {
  const { symbol, name, token, metadataURI, hasPool, marketPriceUsd } = project;
  const { meta } = useProjectMeta(metadataURI);
  const priceStr = marketPriceUsd !== undefined ? formatSmallUsd(Number(marketPriceUsd) / 1e18) : "—";

  return (
    <Link
      href={`/app/token/${token}`}
      className="card-raised card-hover block rounded-card p-5 ring-1 ring-inset ring-green/30"
    >
      {/* Placement label — not a ranking badge. */}
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-green-bg px-2.5 py-1 text-xs font-medium text-green">
          <span aria-hidden>◆</span> Protocol token · pinned by BALLAST
        </span>
        <span className="text-xs text-text-faint">not a ranking</span>
      </div>

      <Meander className="my-4" />

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Logo src={ipfsToGateway(meta?.logo)} symbol={symbol} size={56} />
          <div className="min-w-0">
            <div className="truncate font-serif text-xl font-semibold text-bone">{symbol ?? shortAddress(token)}</div>
            <p className="truncate text-sm text-text-muted">{name ?? "BALLASTED"}</p>
          </div>
        </div>
        <div className="text-right">
          <div key={priceStr} className="figure-primary anim-fade text-lg">{priceStr}</div>
          <div className="metric-secondary">{hasPool ? "market price" : "no pool yet"}</div>
        </div>
      </div>

      <p className="mt-4 border-t border-border pt-3 text-sm text-text-secondary">
        The protocol&apos;s own token — the BALLAST team holds <span className="font-semibold text-text-primary">none</span>.
        100% of supply seeded the pool, no presale, no allocation. It grants no ownership, revenue, governance, or claim
        on the protocol or its fees.
      </p>
    </Link>
  );
}
