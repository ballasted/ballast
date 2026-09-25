import type { Address } from "viem";
import { AssetDisc } from "@/components/app/AssetDisc";
import { resolveAssetIdentity, type AssetIdentity, type RegistryAssetRef } from "@/lib/assetIdentity";
import { WETH_ADDRESS } from "@/lib/contracts";
import { cn } from "@/lib/cn";

// Two labelled facts about a launch, read from chain only — never inferred
// from a name or metadata:
//   BACKED BY  the treasury's deposited asset (or "No deposit")
//   POOL       every real quoteAssetsOf(token) entry, one chip each
//
// WETH is chain infrastructure, not a treasury asset — it's never in
// AssetRegistry, so resolveAssetIdentity alone would call it "unrecognized".
// It's special-cased here to the ETH mark specifically, per the design ask
// ("WETH uses the ETH mark") — everything else still goes through the same
// address-verified registry check backing chips already use, so an impostor
// pool naming itself "NVDA" still can't borrow the real logo.
function quoteIdentity(quoteAsset: Address, registry: RegistryAssetRef[], registryLoaded: boolean): AssetIdentity {
  if (WETH_ADDRESS && quoteAsset.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    return { status: "recognized", symbol: "ETH" };
  }
  return resolveAssetIdentity(quoteAsset, undefined, registry, registryLoaded);
}

function identitySymbol(identity: AssetIdentity, fallbackLabel: string): string {
  return identity.status === "recognized" ? identity.symbol : fallbackLabel;
}

/** BACKED BY chip — the treasury's real deposited asset, or an honest "No deposit". */
export function BackedByChip({
  backingAsset,
  registry,
  registryLoaded,
  compact = false,
  className,
}: {
  backingAsset?: Address;
  registry: RegistryAssetRef[];
  registryLoaded: boolean;
  compact?: boolean;
  className?: string;
}) {
  if (!backingAsset) {
    if (compact) return null; // narrow rows: only show something when there IS a deposit
    return <span className={cn("chip chip-neutral", className)}>No deposit</span>;
  }
  const identity = resolveAssetIdentity(backingAsset, undefined, registry, registryLoaded);
  const symbol = identitySymbol(identity, "…");
  if (compact) {
    return (
      <span title={`Backed by ${symbol}`}>
        <AssetDisc identity={identity} size={16} />
      </span>
    );
  }
  return (
    <span className={cn("chip chip-accent", className)} title={`Backed by ${symbol}`}>
      <AssetDisc identity={identity} size={16} /> {symbol}
    </span>
  );
}

/** POOL chips — one per real quoteAssetsOf(token) entry. Empty array renders nothing. */
export function PoolChips({
  quoteAssets,
  registry,
  registryLoaded,
  compact = false,
  className,
}: {
  quoteAssets: Address[];
  registry: RegistryAssetRef[];
  registryLoaded: boolean;
  compact?: boolean;
  className?: string;
}) {
  if (quoteAssets.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {!compact && <span className="text-xs text-text-faint">Pool</span>}
      {quoteAssets.map((qa) => {
        const identity = quoteIdentity(qa, registry, registryLoaded);
        const symbol = identitySymbol(identity, "…");
        return compact ? (
          <span key={qa} title={symbol}>
            <AssetDisc identity={identity} size={16} />
          </span>
        ) : (
          <span key={qa} className="chip chip-neutral" title={symbol}>
            <AssetDisc identity={identity} size={16} /> {symbol}
          </span>
        );
      })}
    </span>
  );
}
