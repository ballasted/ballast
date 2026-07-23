"use client";

import { useParams } from "next/navigation";
import type { Address } from "viem";
import { useBacking } from "@/hooks/useBacking";
import { useNow } from "@/hooks/useNow";
import { BackingPanel } from "@/components/app/BackingPanel";
import { PendingWithdrawalBanner } from "@/components/app/PendingWithdrawalBanner";
import { activeChain } from "@/lib/chain";
import { shortAddress } from "@/lib/format";

// Token detail — the shareable unit. `[address]` is currently the ProjectTreasury
// address; once BallastFactory ships and the token stores its treasury immutably,
// this will accept the token address and resolve treasury() from it.
export default function TokenDetailPage() {
  const params = useParams();
  const raw = typeof params.address === "string" ? params.address : "";
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(raw);
  const treasury = isAddr ? (raw as Address) : undefined;

  const now = useNow();
  const { backing, symbol, name, pending, isConfigured, isLoading, found } = useBacking(treasury);

  if (!isAddr) {
    return <Notice title="Invalid address" body="This token page needs a valid treasury address." />;
  }
  if (!isConfigured) {
    return <Notice title="Not configured" body="BackingLens address isn't set yet. Deploy the core contracts and set NEXT_PUBLIC_LENS_ADDRESS." />;
  }
  if (isLoading) {
    return <div className="card h-40 animate-pulse" />;
  }
  if (!found || !backing || !treasury) {
    return <Notice title="Nothing here" body="No treasury found at this address on the active chain." />;
  }
  const t: Address = treasury;

  return (
    <div className="space-y-4">
      {/* Pending-withdrawal banner ABOVE everything, including the header. */}
      {pending && <PendingWithdrawalBanner pending={pending} now={now} />}

      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold text-text-primary">
            {symbol ?? shortAddress(t)}
          </h1>
          <p className="truncate text-sm text-text-muted">{name ?? "Unnamed project"}</p>
        </div>
        <div className="text-right">
          {/* Market price needs a pool + quoter (not built). Honest placeholder. */}
          <div className="figure-primary text-2xl">—</div>
          <div className="metric-secondary">market price n/a</div>
        </div>
      </header>

      <BackingPanel backing={backing} symbol={symbol ?? ""} now={now} />

      {/* Buy/Sell pinned within thumb reach — disabled until a pool exists. */}
      <div className="sticky bottom-20 grid grid-cols-2 gap-3">
        <button
          disabled
          className="cursor-not-allowed rounded-button bg-green/40 py-3 font-semibold text-bg"
          title="Trading available after the pool is deployed"
        >
          Buy
        </button>
        <button
          disabled
          className="cursor-not-allowed rounded-button border border-border py-3 font-semibold text-text-muted"
          title="Trading available after the pool is deployed"
        >
          Sell
        </button>
      </div>

      <a
        href={`${activeChain.blockExplorers.default.url}/address/${t}`}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs text-text-faint hover:text-text-secondary"
      >
        Verify this treasury on-chain ↗
      </a>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <h1 className="font-semibold text-text-primary">{title}</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}
