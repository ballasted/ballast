"use client";

import { useEffect } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import {
  backingLensAbi,
  projectTreasuryAbi,
  erc20Abi,
  ballastTokenAbi,
  ballastFactoryAbi,
  stateViewAbi,
  aggregatorV3Abi,
} from "@/lib/abis";
import {
  LENS_ADDRESS,
  FACTORY_ADDRESSES,
  STATE_VIEW_ADDRESS,
  ETH_USD_FEED_ADDRESS,
  WETH_ADDRESS,
  hookForFactory,
  isLensConfigured,
  isFactoryConfigured,
  isSwapConfigured,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { candidatePoolKeys, poolKeyForToken, poolId, tokenIsCurrency0, tokenPriceInQuote } from "@/lib/pool";
import { usdToDoublePrice } from "@/lib/liquidity";
import { liveQuery } from "@/lib/refresh";
import { devReconcileBig } from "@/lib/reconcile";
import type { ProjectBacking } from "./useProjects";

const CHAIN_ID = activeChain.id;

export type PendingWithdrawal = {
  id: bigint;
  asset: Address;
  amount: bigint;
  unlockAt: bigint;
};

/**
 * Token-detail data, keyed by the TOKEN address (the shareable unit). Resolves the
 * treasury on-chain via token.treasury(), reads backing through BackingLens, the
 * pending withdrawal, and — if a pool exists — the live market price from the v4
 * StateView, converted to USD via the ETH/USD feed. Reads are grouped by contract
 * (homogeneous ABIs) and batched through the multicall transport.
 */
export function useBacking(token?: Address) {
  // token -> treasury (immutable pointer).
  const treasuryRes = useReadContract({
    address: token,
    abi: ballastTokenAbi,
    functionName: "treasury",
    chainId: CHAIN_ID,
    query: liveQuery(Boolean(token)),
  });
  const treasury = treasuryRes.data as Address | undefined;

  const metaRes = useReadContracts({
    allowFailure: true,
    contracts: token
      ? [
          { address: token, abi: erc20Abi, functionName: "name", chainId: CHAIN_ID },
          { address: token, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID },
          { address: token, abi: ballastTokenAbi, functionName: "metadataURI", chainId: CHAIN_ID },
          { address: token, abi: ballastTokenAbi, functionName: "launchMetadataURI", chainId: CHAIN_ID },
          { address: token, abi: ballastTokenAbi, functionName: "metadataChanged", chainId: CHAIN_ID },
          { address: token, abi: ballastTokenAbi, functionName: "creator", chainId: CHAIN_ID },
          { address: token, abi: erc20Abi, functionName: "totalSupply", chainId: CHAIN_ID },
        ]
      : [],
    query: liveQuery(Boolean(token)),
  });
  const pick = (i: number) => (metaRes.data?.[i]?.status === "success" ? metaRes.data[i].result : undefined);
  const name = pick(0) as string | undefined;
  const symbol = pick(1) as string | undefined;
  // On-chain pointer to the pinned project metadata JSON (the source of truth).
  const metadataURI = pick(2) as string | undefined;
  const launchMetadataURI = pick(3) as string | undefined;
  const metadataChanged = Boolean(pick(4));
  const creator = pick(5) as Address | undefined;
  const totalSupply = pick(6) as bigint | undefined;

  // Resolve which factory OWNS this token (multi-factory union) via launchIdOf > 0,
  // newest-first. A token launched by a PRIOR factory ($BALLAST) must have its
  // graduation status — and its graduate() call — routed to THAT factory. Checking
  // the current factory, which never created it, always reports not-graduated and
  // makes graduate() revert (the "Launch incomplete" + reverting-Resume bug).
  const ownerRes = useReadContracts({
    allowFailure: true,
    contracts: token
      ? FACTORY_ADDRESSES.map(
          (f) => ({ address: f, abi: ballastFactoryAbi, functionName: "launchIdOf", args: [token], chainId: CHAIN_ID }) as const,
        )
      : [],
    query: liveQuery(isFactoryConfigured && Boolean(token) && FACTORY_ADDRESSES.length > 0),
  });
  let ownerFactory: Address | undefined;
  for (let i = 0; i < FACTORY_ADDRESSES.length; i++) {
    const r = ownerRes.data?.[i];
    if (r?.status === "success" && (r.result as bigint) > 0n) {
      ownerFactory = FACTORY_ADDRESSES[i];
      break;
    }
  }

  const graduatedRes = useReadContract({
    address: ownerFactory,
    abi: ballastFactoryAbi,
    functionName: "graduated",
    args: token ? [token] : undefined,
    chainId: CHAIN_ID,
    query: liveQuery(Boolean(token && ownerFactory)),
  });
  const graduated = Boolean(graduatedRes.data);

  const backingRes = useReadContract({
    address: LENS_ADDRESS,
    abi: backingLensAbi,
    functionName: "backingOf",
    args: treasury ? [treasury] : undefined,
    chainId: CHAIN_ID,
    query: liveQuery(isLensConfigured && Boolean(treasury)),
  });
  const backing = backingRes.data as unknown as ProjectBacking | undefined;

  const treasuryStateRes = useReadContracts({
    allowFailure: true,
    contracts: treasury
      ? [
          { address: treasury, abi: projectTreasuryAbi, functionName: "pendingWithdrawal", chainId: CHAIN_ID },
          { address: treasury, abi: projectTreasuryAbi, functionName: "noticePeriod", chainId: CHAIN_ID },
        ]
      : [],
    query: liveQuery(Boolean(treasury)),
  });
  let pending: PendingWithdrawal | undefined;
  const pw = treasuryStateRes.data?.[0];
  if (pw?.status === "success") {
    const [id, asset, amount, unlockAt] = pw.result as unknown as [bigint, Address, bigint, bigint];
    if (id > 0n) pending = { id, asset, amount, unlockAt };
  }
  const noticePeriod =
    treasuryStateRes.data?.[1]?.status === "success" ? (treasuryStateRes.data[1].result as bigint) : undefined;

  // Which quote asset(s) this launch actually graduated against — read live via
  // quoteAssetsOf, NOT assumed to be WETH. A launch may pair against NVDA/SPY/SGOV
  // instead of (or alongside) WETH; a prior factory that predates quoteAssetsOf()
  // simply fails this call (allowFailure) and falls back to its only possible
  // shape: a single WETH pool. Without this, an NVDA-only launch (no WETH pool at
  // all, e.g. HARUNA) reads hasPool=false forever regardless of the artifact fix
  // below — SwapPanel gates its OWN pool lookup on this hook's hasPool, so a wrong
  // hasPool here makes the token untradeable in the UI even though its real pool
  // works fine on-chain.
  const quoteAssetsRes = useReadContract({
    address: ownerFactory,
    abi: ballastFactoryAbi,
    functionName: "quoteAssetsOf",
    args: token ? [token] : undefined,
    chainId: CHAIN_ID,
    query: { ...liveQuery(Boolean(token && ownerFactory)), retry: false },
  });
  const quoteAssets: Address[] =
    quoteAssetsRes.status === "success" && Array.isArray(quoteAssetsRes.data) && (quoteAssetsRes.data as Address[]).length > 0
      ? (quoteAssetsRes.data as Address[])
      : WETH_ADDRESS
        ? [WETH_ADDRESS]
        : [];

  // Market price via StateView(getSlot0/getLiquidity) + ETH/USD feed. Hook-aware: a
  // token's pool lives under exactly one of the deployed hooks (its own, fixed at
  // graduation), so probe every candidate and use the one with live liquidity. This
  // is why a prior-hook token ($BALLAST/CHRS) keeps an on-chain price after a hook
  // redeploy instead of silently reading the wrong (empty) poolId.
  // Pairing: once the owning factory is resolved, probe only ITS hook's pool (one
  // read pair) per quote asset, not every deployed hook. Until ownerFactory
  // resolves (or if it has no paired hook), fall back to probing all candidates so
  // a prior-hook token still prices correctly.
  const pairedHook = hookForFactory(ownerFactory);
  const candidates = !token
    ? []
    : quoteAssets.flatMap((quoteAsset) => {
        if (pairedHook) {
          const key = poolKeyForToken(token, quoteAsset, pairedHook);
          return key ? [{ quoteAsset, hook: pairedHook, key, id: poolId(key) }] : [];
        }
        return candidatePoolKeys(token, quoteAsset).map((c) => ({ quoteAsset, ...c }));
      });
  const poolRes = useReadContracts({
    allowFailure: true,
    contracts:
      STATE_VIEW_ADDRESS && candidates.length > 0
        ? candidates.flatMap((c) => [
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getSlot0", args: [c.id], chainId: CHAIN_ID } as const,
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getLiquidity", args: [c.id], chainId: CHAIN_ID } as const,
          ])
        : [],
    query: liveQuery(isSwapConfigured && candidates.length > 0),
  });
  const ethRes = useReadContracts({
    allowFailure: true,
    contracts: ETH_USD_FEED_ADDRESS
      ? [
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "latestRoundData", chainId: CHAIN_ID },
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "decimals", chainId: CHAIN_ID },
        ]
      : [],
    query: liveQuery(Boolean(ETH_USD_FEED_ADDRESS)),
  });

  // hasPool is true the moment ANY quote asset resolves to a real, initialized
  // pool (sqrtPriceX96 > 0, set permanently by PoolManager.initialize() at seed
  // time) — NOT getLiquidity(poolId) > 0, which reads 0 exactly when the current
  // tick sits on the seeded position's boundary (the half-open tick-range
  // artifact, confirmed on real graduated pools 2026-09-25) even though the
  // position is real and fully seeded. USD price/depth stay WETH-specific (the
  // only quote asset this app can currently convert to USD) — an NVDA-only pool
  // sets hasPool but leaves marketPriceUsd undefined, honestly.
  let hasPool = false;
  let marketPriceWeth: bigint | undefined;
  let poolLiquidity: bigint | undefined;
  let poolSqrtPriceX96: bigint | undefined;
  const resolvedQuoteAssets = new Set<string>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const qaKey = c.quoteAsset.toLowerCase();
    if (resolvedQuoteAssets.has(qaKey)) continue; // already found this quote asset's live pool
    const slot0 = poolRes.data?.[i * 2];
    const liq = poolRes.data?.[i * 2 + 1];
    if (slot0?.status === "success") {
      const [sqrtPriceX96] = slot0.result as unknown as [bigint, number, number, number];
      if (sqrtPriceX96 > 0n) {
        hasPool = true;
        resolvedQuoteAssets.add(qaKey);
        if (WETH_ADDRESS && qaKey === WETH_ADDRESS.toLowerCase() && token) {
          marketPriceWeth = tokenPriceInQuote(sqrtPriceX96, tokenIsCurrency0(token, WETH_ADDRESS), 18);
          poolSqrtPriceX96 = sqrtPriceX96;
          if (liq?.status === "success") poolLiquidity = liq.result as bigint;
        }
      }
    }
  }

  let ethUsd1e18: bigint | undefined;
  if (ethRes.data?.[0]?.status === "success" && ethRes.data?.[1]?.status === "success") {
    const answer = (ethRes.data[0].result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer > 0n) ethUsd1e18 = (answer * 10n ** 18n) / 10n ** BigInt(ethRes.data[1].result as number);
  }
  const marketPriceUsd =
    marketPriceWeth !== undefined && ethUsd1e18 !== undefined
      ? (marketPriceWeth * ethUsd1e18) / 10n ** 18n
      : undefined;
  const depthToDoubleUsd = usdToDoublePrice(poolLiquidity, poolSqrtPriceX96, ethUsd1e18);

  // Dev-only reconciliation (spec 1.4): the two supply reads that feed market cap
  // (token.totalSupply() and BackingLens.totalSupply) must agree, or the same
  // token's market cap could differ between this page and Discover. Flag drift loud.
  useEffect(() => {
    devReconcileBig("totalSupply: token vs BackingLens", totalSupply, backing?.totalSupply);
  }, [totalSupply, backing?.totalSupply]);

  return {
    treasury,
    token,
    backing,
    name,
    symbol,
    metadataURI,
    launchMetadataURI,
    metadataChanged,
    creator,
    totalSupply,
    pending,
    noticePeriod,
    graduated,
    ownerFactory,
    hasPool,
    quoteAssets,
    marketPriceWeth,
    marketPriceUsd,
    depthToDoubleUsd,
    isConfigured: isLensConfigured,
    isLoading: treasuryRes.isLoading || backingRes.isLoading,
    found: Boolean(treasury),
  };
}
