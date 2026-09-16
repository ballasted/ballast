"use client";

import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { stateViewAbi } from "@/lib/abis";
import { BUYBACK_ADDRESS, STATE_VIEW_ADDRESS, WETH_ADDRESS, isBuybackConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { poolId, tokenPriceInQuote, type PoolKey } from "@/lib/pool";
import { buybackBurnerAbi, useBuyback } from "./useBuyback";
import { useEthUsd } from "./useEthUsd";
import { useMarket } from "./useMarket";

const CHAIN_ID = activeChain.id;

/** $BALLAST's own market cap for the shell ticker bar. Price/market cap come
 *  from the SAME on-chain source as every other token's price (v4 StateView),
 *  read through BuybackBurner's own `poolKey()` rather than the factory-launch
 *  pairing logic in useProjects (which $BALLAST, the protocol's own token, is
 *  not part of). 24h% has no on-chain history mechanism, so it comes from
 *  GeckoTerminal (market colour, same as every other token's change%) and is
 *  left undefined — never guessed — when that pool isn't indexed there yet. */
export function useBallastMarket() {
  const { ballast, totalSupply } = useBuyback();
  const { ethUsd1e18 } = useEthUsd();

  const keyRes = useReadContracts({
    allowFailure: true,
    contracts: BUYBACK_ADDRESS
      ? [{ address: BUYBACK_ADDRESS, abi: buybackBurnerAbi, functionName: "poolKey", chainId: CHAIN_ID }]
      : [],
    query: liveQuery(isBuybackConfigured),
  });

  let key: PoolKey | undefined;
  if (keyRes.data?.[0]?.status === "success") {
    const [currency0, currency1, fee, tickSpacing, hooks] = keyRes.data[0].result as unknown as [
      Address,
      Address,
      number,
      number,
      Address,
    ];
    key = { currency0, currency1, fee, tickSpacing, hooks };
  }
  const id = key ? poolId(key) : undefined;

  const poolRes = useReadContracts({
    allowFailure: true,
    contracts:
      STATE_VIEW_ADDRESS && id
        ? [
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getSlot0", args: [id], chainId: CHAIN_ID },
            { address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getLiquidity", args: [id], chainId: CHAIN_ID },
          ]
        : [],
    query: liveQuery(Boolean(STATE_VIEW_ADDRESS && id)),
  });

  let priceWethPerBallast: bigint | undefined;
  let hasPool = false;
  const liq = poolRes.data?.[1];
  const slot0 = poolRes.data?.[0];
  if (liq?.status === "success" && (liq.result as bigint) > 0n && slot0?.status === "success" && key) {
    hasPool = true;
    const [sqrtPriceX96] = slot0.result as unknown as [bigint, number, number, number];
    if (sqrtPriceX96 > 0n) {
      const ballastIsCurrency0 = WETH_ADDRESS ? key.currency1.toLowerCase() === WETH_ADDRESS.toLowerCase() : true;
      // WETH is always 18-decimal — the one case this generalized helper is used
      // for a fixed, known quote asset rather than a variable one.
      priceWethPerBallast = tokenPriceInQuote(sqrtPriceX96, ballastIsCurrency0, 18);
    }
  }

  const priceUsd1e18 =
    priceWethPerBallast !== undefined && ethUsd1e18 !== undefined
      ? (priceWethPerBallast * ethUsd1e18) / 10n ** 18n
      : undefined;
  const marketCapUsd1e18 =
    priceUsd1e18 !== undefined && totalSupply !== undefined ? (priceUsd1e18 * totalSupply) / 10n ** 18n : undefined;

  // 24h% only — GeckoTerminal, market colour, never the price source above.
  const { market } = useMarket(ballast);

  return {
    configured: isBuybackConfigured,
    isLoading: keyRes.isLoading || poolRes.isLoading,
    hasPool,
    priceUsd1e18,
    marketCapUsd1e18,
    change24hPct: market?.available ? market.change24hPct ?? undefined : undefined,
  };
}
