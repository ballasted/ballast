"use client";

import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount } from "wagmi";
import { useBasketHistory } from "@/hooks/useBasketHistory";
import { BasketPicker } from "@/components/app/basket/BasketPicker";
import { AssetDisc } from "@/components/app/AssetDisc";
import { formatUsd, formatDuration, shortAddress } from "@/lib/format";
import { isBasketEnabled } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import type { ProjectBacking } from "@/hooks/useProjects";

type BackingAssetValueView = { asset: Address; withdrawableValueUsd: bigint };

/// Stock Basket — the creator-only "Add basket" entry point plus a read-only
/// history card. There is no separate on-chain "basket" bookkeeping (a basket
/// leg is an ordinary treasury deposit the moment the creator calls
/// deposit()), so "weights at deposit" comes from BasketZap's event log
/// (useBasketHistory) and "current value" is read live through the SAME
/// BackingLens call the rest of the backing page already uses (`backing`,
/// passed down rather than re-fetched). Renders nothing when the feature
/// flag is off or unconfigured — same convention as OpenTreasurySection.
export function BasketSection({
  token,
  treasury,
  creator,
  symbol,
  noticePeriod,
  backing,
}: {
  token?: Address;
  treasury?: Address;
  creator?: Address;
  symbol?: string;
  noticePeriod?: bigint;
  backing?: ProjectBacking;
}) {
  const { address: account } = useAccount();
  const history = useBasketHistory(token);
  const [adding, setAdding] = useState(false);
  const isCreator = Boolean(account && creator && account.toLowerCase() === creator.toLowerCase());

  if (!isBasketEnabled || !token || !treasury) return null;

  const assetViews = (backing?.assets ?? []) as unknown as BackingAssetValueView[];
  const valueOf = (asset: Address): bigint | undefined => {
    const a = assetViews.find((x) => x.asset.toLowerCase() === asset.toLowerCase());
    return a?.withdrawableValueUsd;
  };

  return (
    <section className="card space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h2 className="section-label">Basket</h2>
        {isCreator && !adding && (
          <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
            Add basket
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-input border border-border p-4">
          <BasketPicker launchToken={token} treasury={treasury} onDone={() => setAdding(false)} />
        </div>
      )}

      {!adding && !history.hasHistory && (
        <p className="text-sm text-text-faint">
          {isCreator ? "No basket added yet." : "This creator hasn't added a basket."}
        </p>
      )}

      {!adding &&
        history.swaps.map((swap) => (
          <div key={swap.txHash} className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
            {swap.legs.map((leg) => (
              <div key={leg.asset} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <AssetDisc identity={{ status: "recognized", symbol: "" }} size={20} />
                  <span className="text-text-primary">{leg.weightBps / 100}%</span>
                  <span className="font-mono text-xs text-text-faint">{shortAddress(leg.asset)}</span>
                </span>
                <span className="tabular-nums text-text-muted">
                  {valueOf(leg.asset) !== undefined ? formatUsd(valueOf(leg.asset)!, { compact: true }) : "—"}
                </span>
              </div>
            ))}
            <a
              className="block text-xs text-text-faint hover:text-text-secondary"
              href={`${activeChain.blockExplorers.default.url}/tx/${swap.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View swap on Blockscout ↗
            </a>
          </div>
        ))}

      {history.status === "partial" && (
        <p className="text-xs text-warning">History may be incomplete — the RPC only returned part of the scan.</p>
      )}

      {!adding && noticePeriod !== undefined && (
        <p className="text-xs text-text-faint">
          Withdrawable by the creator with {formatDuration(Number(noticePeriod))} notice, same as any other treasury deposit.
        </p>
      )}

      {/* Disclaimer — INSIDE this panel, hard rule 5 (this panel shows treasury
          asset values, same as BackingPanel). */}
      <p className="rounded-input bg-bg px-3 py-2 text-xs text-text-muted">
        Holding ${symbol || "TICKER"} gives no claim, redemption right, or entitlement to these assets.
      </p>
    </section>
  );
}
