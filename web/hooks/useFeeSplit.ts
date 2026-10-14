"use client";

import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { feeConfigAbi } from "@/lib/abis";
import { feeConfigForFactory } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;

export type FeeSplit = {
  feeBps: number;
  feePct: number; // total swap fee, %
  creatorPct: number;
  platformPct: number;
  referrerPct: number;
};

/**
 * Live fee + split for a launch, read from the FeeConfig of the factory that
 * launched it (pass `factory`; omit it for the current gen-4 config, which the
 * Create flow uses). The split DIFFERS by generation, so it must be resolved
 * per-factory, not from one global env var — `feeConfigForFactory` maps the
 * owning factory to its FeeConfig (code-authoritative addresses), and the BPS
 * are read LIVE here so an owner retune is always reflected. Never hardcode the
 * numbers (CLAUDE.md): a baked-in "50/35/15" or "80/20/0" could silently
 * disagree with a retuned FeeConfig.
 */
export function useFeeSplit(factory?: Address): { split?: FeeSplit; isLoading: boolean; configured: boolean } {
  const address = feeConfigForFactory(factory);

  const res = useReadContract({
    address,
    abi: feeConfigAbi,
    functionName: "feeParams",
    chainId: CHAIN_ID,
    query: { enabled: Boolean(address) },
  });

  const d = res.data as readonly [number, number, number, number, `0x${string}`] | undefined;

  if (!d) {
    return { split: undefined, isLoading: res.isLoading, configured: Boolean(address) };
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
