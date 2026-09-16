"use client";

import { useReadContracts } from "wagmi";
import { aggregatorV3Abi } from "@/lib/abis";
import { ETH_USD_FEED_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";

const CHAIN_ID = activeChain.id;

/** ETH/USD, 1e18-scaled, read live from the Chainlink feed. Extracted out of
 *  useProjects (which needs it to price every pool) so shell chrome (the
 *  ticker bar) doesn't have to mount the full project-enumeration hook tree
 *  just to show one number. */
export function useEthUsd() {
  const res = useReadContracts({
    allowFailure: true,
    contracts: ETH_USD_FEED_ADDRESS
      ? [
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "latestRoundData", chainId: CHAIN_ID },
          { address: ETH_USD_FEED_ADDRESS, abi: aggregatorV3Abi, functionName: "decimals", chainId: CHAIN_ID },
        ]
      : [],
    query: liveQuery(Boolean(ETH_USD_FEED_ADDRESS)),
  });

  let ethUsd1e18: bigint | undefined;
  if (res.data?.[0]?.status === "success" && res.data?.[1]?.status === "success") {
    const answer = (res.data[0].result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer > 0n) ethUsd1e18 = (answer * 10n ** 18n) / 10n ** BigInt(res.data[1].result as number);
  }

  return { ethUsd1e18, isLoading: res.isLoading, isConfigured: Boolean(ETH_USD_FEED_ADDRESS) };
}
