"use client";

import type { Address } from "viem";
import { useAssets } from "@/hooks/useAssets";
import { resolveAssetIdentity, type AssetIdentity } from "@/lib/assetIdentity";

/**
 * Resolves an address against the live AssetRegistry — see lib/assetIdentity.ts
 * for why this is address-first, never symbol-first. Every reserve-asset
 * display call site should go through this (or resolveAssetIdentity directly,
 * if it already has useAssets() data from elsewhere) instead of trusting a bare
 * symbol string.
 */
export function useAssetIdentity(address: Address | undefined, claimedSymbol?: string): AssetIdentity {
  const { assets, isLoading } = useAssets();
  return resolveAssetIdentity(address, claimedSymbol, assets, !isLoading);
}
