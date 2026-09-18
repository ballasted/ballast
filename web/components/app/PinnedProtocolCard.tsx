"use client";

import Link from "next/link";
import type { Project } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { ipfsToGateway } from "@/lib/ipfs";
import { AssetDisc } from "@/components/app/AssetDisc";
import { Meander } from "@/components/Meander";
import { formatSmallUsd } from "@/lib/market";
import { shortAddress } from "@/lib/format";

// The protocol token ($BALLAST), pinned above the grid — a placement, not a
// ranked card, so it keeps its own raised surface rather than the standard
// ProjectCard. We don't vouch for anyone, so our own token being first must
// read as us putting it there.
export function PinnedProtocolCard({ project }: { project: Project }) {
  const { symbol, name, token, metadataURI, marketPriceUsd } = project;
  const { meta } = useProjectMeta(metadataURI);
  const priceStr = marketPriceUsd !== undefined ? formatSmallUsd(Number(marketPriceUsd) / 1e18) : "—";

  return (
    <Link
      href={`/app/token/${token}`}
      className="card-raised card-hover block rounded-card p-5 ring-1 ring-inset ring-green/30"
    >
      <span className="chip chip-accent">
        <span aria-hidden>◆</span> Protocol token · pinned by BALLAST
      </span>

      <Meander className="my-4" />

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AssetDisc src={ipfsToGateway(meta?.logo)} symbol={symbol} size={56} />
          <div className="min-w-0">
            <div className="truncate font-serif text-xl font-semibold text-bone">{symbol ?? shortAddress(token)}</div>
            <p className="truncate text-sm text-text-muted">{name ?? "BALLASTED"}</p>
          </div>
        </div>
        <div key={priceStr} className="figure-primary anim-fade text-lg">{priceStr}</div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center text-sm">
        <AllocationRow label="Team allocation" value="None" />
        <AllocationRow label="Presale" value="None" />
        <AllocationRow label="Governance" value="None" />
      </div>
    </Link>
  );
}

function AllocationRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-text-faint">{label}</div>
      <div className="mt-0.5 font-medium text-text-primary">{value}</div>
    </div>
  );
}
