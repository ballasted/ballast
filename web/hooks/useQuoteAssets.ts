"use client";

import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { ballastFactoryAbi, erc20Abi } from "@/lib/abis";
import { FACTORY_ADDRESS, WETH_ADDRESS, isFactoryConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { useAssets } from "@/hooks/useAssets";

const CHAIN_ID = activeChain.id;

export type QuoteAssetOption = {
  address: Address;
  symbol?: string;
  isWeth: boolean;
};

/** Every quote-asset candidate (WETH + every AssetRegistry-allowed asset),
 *  annotated with whether it's actually selectable today. Lets a picker render
 *  the full set — including non-GREEN assets as visible-but-disabled "coming
 *  soon" entries — instead of silently omitting them (they'd otherwise just
 *  vanish from a filtered list, indistinguishable from "doesn't exist"). */
export type QuoteAssetCandidate = QuoteAssetOption & { isGreen: boolean };

/** Quote-asset candidates for the create flow's pool-pairing picker: WETH
 *  (always valid) plus whichever AssetRegistry-allowed assets the CURRENT
 *  factory's isGreenQuoteAsset() actually accepts. A registry-allowed
 *  treasury asset is NOT automatically a valid quote asset — the green list
 *  is a separate, deploy-time-fixed factory allowlist (see
 *  docs/exit-liquidity-table.md) — so this always checks isGreenQuoteAsset
 *  live rather than assuming every registry asset qualifies.
 *
 *  Returns BOTH `options` (selectable, GREEN-only — unchanged shape, existing
 *  callers keep working) and `candidates` (the full list, GREEN and not,
 *  each flagged `isGreen`) so a picker can show every asset without ever
 *  treating an unresolved/failed isGreenQuoteAsset read as green. */
export function useQuoteAssets() {
  const { assets, isLoading: assetsLoading, isConfigured: registryConfigured } = useAssets();
  const candidates = assets.map((a) => a.address);

  const res = useReadContracts({
    allowFailure: true,
    contracts: [
      ...(WETH_ADDRESS ? [{ address: WETH_ADDRESS, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID } as const] : []),
      { address: FACTORY_ADDRESS!, abi: ballastFactoryAbi, functionName: "MAX_QUOTE_ASSETS", chainId: CHAIN_ID } as const,
      ...candidates.map(
        (a) =>
          ({
            address: FACTORY_ADDRESS!,
            abi: ballastFactoryAbi,
            functionName: "isGreenQuoteAsset",
            args: [a],
            chainId: CHAIN_ID,
          }) as const,
      ),
    ],
    query: { enabled: isFactoryConfigured },
  });

  let cursor = 0;
  const options: QuoteAssetOption[] = [];
  const allCandidates: QuoteAssetCandidate[] = [];
  if (WETH_ADDRESS) {
    const symRes = res.data?.[cursor];
    cursor += 1;
    const weth: QuoteAssetCandidate = {
      address: WETH_ADDRESS,
      symbol: symRes?.status === "success" ? (symRes.result as string) : "WETH",
      isWeth: true,
      isGreen: true,
    };
    options.push(weth);
    allCandidates.push(weth);
  }
  const maxRes = res.data?.[cursor];
  cursor += 1;
  const maxQuoteAssets = maxRes?.status === "success" ? Number(maxRes.result as bigint) : undefined;

  candidates.forEach((addr, i) => {
    const greenRes = res.data?.[cursor + i];
    // Treat anything not a confirmed on-chain `true` (unresolved, failed, or
    // false) as not-green — never mark a candidate selectable on a guess.
    const isGreen = greenRes?.status === "success" && Boolean(greenRes.result);
    const meta = assets.find((a) => a.address.toLowerCase() === addr.toLowerCase());
    const candidate: QuoteAssetCandidate = { address: addr, symbol: meta?.symbol, isWeth: false, isGreen };
    allCandidates.push(candidate);
    if (isGreen) options.push(candidate);
  });

  return {
    options,
    candidates: allCandidates,
    maxQuoteAssets,
    isConfigured: isFactoryConfigured && registryConfigured,
    isLoading: assetsLoading || res.isLoading,
  };
}
