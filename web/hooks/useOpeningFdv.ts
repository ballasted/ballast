"use client";

import { useReadContract, useReadContracts } from "wagmi";
import { ballastFactoryAbi, aggregatorV3Abi } from "@/lib/abis";
import { FACTORY_ADDRESS, ETH_USD_FEED_ADDRESS, isFactoryConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;
const SUPPLY_WHOLE = 1_000_000_000; // 1B tokens — mirrors the factory's TOTAL_SUPPLY.

/**
 * The opening valuation of an UNBACKED launch, read live so the create flow shows a
 * number, not a description. The factory opens every unbacked pool at UNBACKED_TICK
 * (a constant getter on the deployed factory): price = 1.0001^tick WETH/token, and
 * FDV = price × 1B supply (≈ 1 ETH). The pool is priced in WETH and carries NO
 * oracle, so the dollar figure is just today's ETH price × the WETH FDV — it moves
 * with ETH. Both legs allowFailure so a missing feed just hides the USD figure.
 */
export function useOpeningFdv() {
  const tickRes = useReadContract({
    address: FACTORY_ADDRESS,
    abi: ballastFactoryAbi,
    functionName: "UNBACKED_TICK",
    chainId: CHAIN_ID,
    query: { enabled: isFactoryConfigured },
  });

  const ethRes = useReadContracts({
    allowFailure: true,
    contracts: ETH_USD_FEED_ADDRESS
      ? [
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "latestRoundData", chainId: CHAIN_ID },
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "decimals", chainId: CHAIN_ID },
        ]
      : [],
    query: { enabled: Boolean(ETH_USD_FEED_ADDRESS) },
  });

  const tick = tickRes.data !== undefined ? Number(tickRes.data) : undefined;
  const fdvWeth = tick !== undefined ? Math.pow(1.0001, tick) * SUPPLY_WHOLE : undefined;

  let ethUsd: number | undefined;
  if (ethRes.data?.[0]?.status === "success" && ethRes.data?.[1]?.status === "success") {
    const answer = (ethRes.data[0].result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
    const dec = ethRes.data[1].result as number;
    if (answer > 0n) ethUsd = Number(answer) / 10 ** dec;
  }
  const fdvUsd = fdvWeth !== undefined && ethUsd !== undefined ? fdvWeth * ethUsd : undefined;

  return { tick, fdvWeth, fdvUsd, ethUsd, isLoading: tickRes.isLoading };
}
