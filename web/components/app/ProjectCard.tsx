"use client";

import { useState } from "react";
import Link from "next/link";
import type { Project } from "@/hooks/useProjects";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { useDenylist } from "@/hooks/useDenylist";
import { useAssets } from "@/hooks/useAssets";
import { resolveAssetIdentity } from "@/lib/assetIdentity";
import { ipfsToGateway } from "@/lib/ipfs";
import { AssetDisc } from "@/components/app/AssetDisc";
import { formatUsd, shortAddress } from "@/lib/format";
import { marketCapUsd, marketCapSupply } from "@/lib/market";
import { Meander } from "@/components/Meander";
import { cn } from "@/lib/cn";

type BackingAssetView = { asset: `0x${string}` };

// THE card, for every token, everywhere (UI principles §5 — one card, one
// density, no exceptions for Featured/Trending/New/Ballasted/pinned rows).
// Exactly five things, in this order, nothing else: image, $TICKER + name,
// market cap, one backing chip, one state pill.
export function ProjectCard({ project }: { project: Project }) {
  const { symbol, name, backing, token, metadataURI, hasPool, marketPriceUsd } = project;
  const { meta } = useProjectMeta(metadataURI);
  // Denylisted tokens still appear (ticker + address, still link to the token
  // page) but their project-supplied metadata is withheld — no logo, no name.
  const { isDenied } = useDenylist();
  const denied = isDenied(token);
  const shownMeta = denied ? undefined : meta;
  const logo = ipfsToGateway(shownMeta?.logo);

  // Backing chip's symbol is resolved by ADDRESS against the live AssetRegistry
  // (same check the create flow and CLAUDE.md rule 14 require) — never by
  // trusting a claimed ticker string, so an impostor token can't borrow a real
  // asset's mark just by matching its symbol.
  const { assets: registry, isLoading: registryLoading } = useAssets();
  const ballasted = Boolean(backing && backing.totalValueUsd > 0n);
  const backingAsset = (backing?.assets as unknown as BackingAssetView[] | undefined)?.[0];
  const identity = resolveAssetIdentity(backingAsset?.asset, undefined, registry, !registryLoading);

  const mcap1e18 = marketCapUsd(marketPriceUsd, marketCapSupply(backing?.totalSupply));

  return (
    <Link href={`/app/token/${token}`} className="card card-hover group flex h-full flex-col overflow-hidden">
      <CardMedia logo={logo} symbol={symbol} />

      <div className="flex flex-1 flex-col p-4">
        <div className="min-w-0">
          <span className="truncate font-semibold text-text-primary">{symbol ?? shortAddress(token)}</span>
          <p className="truncate text-sm text-text-muted">{denied ? "Metadata withheld" : (name ?? shortAddress(token))}</p>
        </div>

        <div className="figure-primary mt-2 text-lg tabular-nums">
          {mcap1e18 !== undefined ? formatUsd(mcap1e18, { compact: true }) : "—"}
        </div>

        <div className="mt-auto flex items-center justify-between gap-2 pt-3">
          {ballasted ? (
            <span className="chip chip-accent">
              Backed by <AssetDisc identity={identity} size={16} />{" "}
              {identity.status === "recognized" ? identity.symbol : "…"}
            </span>
          ) : (
            <span className="chip chip-neutral">No treasury</span>
          )}
          <span className={cn("chip", hasPool ? "chip-accent" : "chip-neutral")}>
            {hasPool ? "Graduated" : "On curve"}
          </span>
        </div>
      </div>
    </Link>
  );
}

// Media band: the project logo, full-bleed, nothing overlaid on it. Falls back
// to a branded initials plate when there's no image (or it fails / is
// withheld), so a card is never a broken image and never a bare grey box.
function CardMedia({ logo, symbol }: { logo?: string; symbol?: string }) {
  const [failed, setFailed] = useState(false);
  const showImg = Boolean(logo) && !failed;
  return (
    <div className="relative aspect-square w-full overflow-hidden border-b border-border bg-surface-raised">
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt=""
          aria-hidden
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="select-none font-serif text-4xl font-semibold tracking-tight text-bone/55">
            {(symbol || "•").slice(0, 3).toUpperCase()}
          </span>
          <Meander className="absolute inset-x-0 bottom-3 px-6 opacity-40" />
        </div>
      )}
    </div>
  );
}
