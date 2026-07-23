"use client";

import { useReadContract } from "wagmi";
import { feeConfigAbi } from "@/lib/abis";
import { FEE_CONFIG_ADDRESS, isFeeConfigConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;

export type FeeSplit = {
  feeBps: number;
  feePct: number; // total swap fee, %
  creatorPct: number;
  platformPct: number;
  referrerPct: number;
};

// Live fee + split from FeeConfig. Never hardcoded — the owner can retune it, so a
// baked-in "50/35/15" could silently disagree with reality (CLAUDE.md). When the
// FeeConfig address is unset the split is `undefined` and the UI shows an honest
// placeholder rather than a guessed number.
export function useFeeSplit(): { split?: FeeSplit; isLoading: boolean; configured: boolean } {
  const res = useReadContract({
    address: FEE_CONFIG_ADDRESS,
    abi: feeConfigAbi,
    functionName: "feeParams",
    chainId: CHAIN_ID,
    query: { enabled: isFeeConfigConfigured },
  });

  const d = res.data as
    | readonly [number, number, number, number, `0x${string}`]
    | undefined;

  if (!d) {
    return { split: undefined, isLoading: res.isLoading, configured: isFeeConfigConfigured };
  }

  const [feeBps, creatorBps, platformBps, referrerBps] = d;
  return {
    configured: true,
    isLoading: false,
    split: {
      feeBps,
      feePct: feeBps / 100,
      creatorPct: creatorBps / 100,
      platformPct: platformBps / 100,
      referrerPct: referrerBps / 100,
    },
  };
}
