"use client";

import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { BUYBACK_V2_ADDRESS, isBuybackV2Configured, WETH_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";

const CHAIN_ID = activeChain.id;

// $BALLAST v2's own NVDA quote asset. Kept as a plain constant here (not
// pulled from AssetRegistry) since BuybackBurnerV2 is hardcoded to exactly
// these two assets at construction — see contracts/src/BuybackBurnerV2.sol.
const NVDA_ADDRESS = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;

export const buybackBurnerV2Abi = [
  { type: "function", name: "ballast", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "burnedBalance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalBallastBurned", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "buybackCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "totalSpent",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "readyAt",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "maxWethPerCall", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxNvdaPerCall", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cooldownSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "BuybackBurned",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "spent", type: "uint256", indexed: false },
      { name: "ballastBought", type: "uint256", indexed: false },
      { name: "totalBallastBurned", type: "uint256", indexed: false },
    ],
  },
] as const;

export type BuybackV2State = {
  configured: boolean;
  isLoading: boolean;
  burnedBalance?: bigint; // $BALLAST v2 at DEAD via this contract's own buys
  totalBallastBurned?: bigint;
  buybackCount?: number;
  wethSpent?: bigint;
  nvdaSpent?: bigint;
  wethPendingBalance?: bigint; // held, not yet spent
  nvdaPendingBalance?: bigint;
  wethReadyAt?: bigint; // unix seconds; 0 means ready now
  nvdaReadyAt?: bigint;
};

/** Live reads for BuybackBurnerV2 — everything the buyback page's v2 section
 *  needs, all-or-nothing gated on isBuybackV2Configured so the page can show
 *  an honest "manual, not live yet" state until it's deployed. */
export function useBuybackV2(): BuybackV2State {
  const res = useReadContracts({
    allowFailure: true,
    contracts: BUYBACK_V2_ADDRESS
      ? ([
          { address: BUYBACK_V2_ADDRESS, abi: buybackBurnerV2Abi, functionName: "burnedBalance", chainId: CHAIN_ID },
          { address: BUYBACK_V2_ADDRESS, abi: buybackBurnerV2Abi, functionName: "totalBallastBurned", chainId: CHAIN_ID },
          { address: BUYBACK_V2_ADDRESS, abi: buybackBurnerV2Abi, functionName: "buybackCount", chainId: CHAIN_ID },
          {
            address: BUYBACK_V2_ADDRESS,
            abi: buybackBurnerV2Abi,
            functionName: "totalSpent",
            args: [WETH_ADDRESS!],
            chainId: CHAIN_ID,
          },
          {
            address: BUYBACK_V2_ADDRESS,
            abi: buybackBurnerV2Abi,
            functionName: "totalSpent",
            args: [NVDA_ADDRESS],
            chainId: CHAIN_ID,
          },
          {
            address: WETH_ADDRESS,
            abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
            functionName: "balanceOf",
            args: [BUYBACK_V2_ADDRESS],
            chainId: CHAIN_ID,
          },
          {
            address: NVDA_ADDRESS,
            abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const,
            functionName: "balanceOf",
            args: [BUYBACK_V2_ADDRESS],
            chainId: CHAIN_ID,
          },
          {
            address: BUYBACK_V2_ADDRESS,
            abi: buybackBurnerV2Abi,
            functionName: "readyAt",
            args: [WETH_ADDRESS!],
            chainId: CHAIN_ID,
          },
          {
            address: BUYBACK_V2_ADDRESS,
            abi: buybackBurnerV2Abi,
            functionName: "readyAt",
            args: [NVDA_ADDRESS],
            chainId: CHAIN_ID,
          },
        ] as const)
      : [],
    query: liveQuery(isBuybackV2Configured),
  });

  const pick = (i: number) => (res.data?.[i]?.status === "success" ? res.data[i].result : undefined);

  return {
    configured: isBuybackV2Configured,
    isLoading: res.isLoading,
    burnedBalance: pick(0) as bigint | undefined,
    totalBallastBurned: pick(1) as bigint | undefined,
    buybackCount: pick(2) !== undefined ? Number(pick(2)) : undefined,
    wethSpent: pick(3) as bigint | undefined,
    nvdaSpent: pick(4) as bigint | undefined,
    wethPendingBalance: pick(5) as bigint | undefined,
    nvdaPendingBalance: pick(6) as bigint | undefined,
    wethReadyAt: pick(7) as bigint | undefined,
    nvdaReadyAt: pick(8) as bigint | undefined,
  };
}
