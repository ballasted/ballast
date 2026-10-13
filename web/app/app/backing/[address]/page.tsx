"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import type { Address } from "viem";
import { useBacking } from "@/hooks/useBacking";
import { useNow } from "@/hooks/useNow";
import { useDenylistEntry } from "@/hooks/useDenylist";
import { useProjectMeta } from "@/hooks/useProjectMeta";
import { BackingPanel } from "@/components/app/BackingPanel";
import { CreatorWithdrawalPanel } from "@/components/app/CreatorWithdrawalPanel";
import { BasketSection } from "@/components/app/token/BasketSection";
import { OpenTreasurySection } from "@/components/app/token/OpenTreasurySection";
import { RamsesLockSection } from "@/components/app/token/RamsesLockSection";
import { AssetDisc } from "@/components/app/AssetDisc";
import { MotionSection } from "@/components/app/MotionSection";
import { ipfsToGateway } from "@/lib/ipfs";
import { shortAddress } from "@/lib/format";
import { activeChain } from "@/lib/chain";

type BackingAssetView = { asset: `0x${string}`; withdrawableBalance: bigint; assetDecimals: number };

// The full backing page for one token — treasury, stock basket, and Ramses
// locked pool, each a self-contained section, same components the token
// page's old "Backing" tab used (not re-implemented, just relocated —
// docs/DECISIONS.md). Linked from the token page's compact summary card and
// from /app/backing (the index).
export default function BackingDetailPage() {
  const params = useParams();
  const raw = typeof params.address === "string" ? params.address : "";
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(raw);
  const token = isAddr ? (raw as Address) : undefined;

  const now = useNow();
  const {
    treasury,
    backing,
    symbol,
    creator,
    pending,
    noticePeriod,
    metadataURI,
    isConfigured,
    isLoading,
    found,
  } = useBacking(token);
  const { meta } = useProjectMeta(metadataURI);
  const { denied: metaDenied } = useDenylistEntry(token);
  const shownMeta = metaDenied ? undefined : meta;

  if (!isAddr) return <Notice title="Invalid address" body="This page needs a valid token address." />;
  if (!isConfigured) {
    return <Notice title="Not configured" body="BackingLens isn't set. Deploy the core contracts and set NEXT_PUBLIC_LENS_ADDRESS." />;
  }
  if (isLoading) return <PageSkeleton />;
  if (!found || !treasury) {
    return <Notice title="Nothing here" body="No BALLAST token found at this address on the active chain." />;
  }

  return (
    <div className="space-y-4">
      <MotionSection>
        <header className="card flex items-center justify-between gap-3 p-5">
          <div className="flex min-w-0 items-center gap-3">
            <AssetDisc src={ipfsToGateway(shownMeta?.logo)} symbol={symbol} size={44} />
            <div className="min-w-0">
              <h1 className="truncate font-serif text-xl font-semibold text-bone">${symbol ?? shortAddress(token!)} backing</h1>
              <Link href={`/app/token/${token}`} className="text-sm text-text-faint hover:text-text-secondary">
                ← Back to ${symbol ?? shortAddress(token!)}
              </Link>
            </div>
          </div>
        </header>
      </MotionSection>

      {backing ? (
        <div className="space-y-4">
          <BackingPanel backing={backing} symbol={symbol ?? ""} now={now} />
          <CreatorWithdrawalPanel
            treasury={treasury}
            creator={creator}
            assets={(backing.assets as unknown as BackingAssetView[]) ?? []}
            noticePeriod={noticePeriod}
            pending={pending}
            symbol={symbol}
            now={now}
          />
          <BasketSection
            token={token}
            treasury={treasury}
            creator={creator}
            symbol={symbol}
            noticePeriod={noticePeriod}
            backing={backing}
          />
          <OpenTreasurySection token={token!} creator={creator} symbol={symbol} />
          <RamsesLockSection token={token!} creator={creator} symbol={symbol} />

          <a
            href={`${activeChain.blockExplorers.default.url}/address/${treasury}`}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs text-text-faint hover:text-text-secondary"
          >
            Treasury on-chain ↗
          </a>
        </div>
      ) : (
        <div className="card p-5 text-sm text-text-muted">No treasury</div>
      )}
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <h1 className="font-serif font-semibold text-bone">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="card p-5">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 animate-pulse rounded-full bg-surface-raised" />
          <div className="space-y-2">
            <div className="h-5 w-32 animate-pulse rounded bg-surface-raised" />
            <div className="h-3 w-24 animate-pulse rounded bg-surface-raised" />
          </div>
        </div>
      </div>
      <div className="card h-40 animate-pulse p-5" />
    </div>
  );
}
