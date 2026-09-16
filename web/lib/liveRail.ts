import type { Address, Hex } from "viem";

// Live rail config (spec §5.6) — one place for the tunable knobs.
//
// ~24h of blocks at this chain's ~100ms block time, same ratio lib/heroStats.ts
// already uses in production for its 7-day window (WEEK_BLOCKS = 6_048_000n,
// this is exactly 1/7th of that). Backfill window, not a hard cutoff — the
// actual scan degrades via lib/eventBackfill.ts if the RPC won't serve it.
export const DAY_BLOCKS = 864_000n;

// "Large buy" — a single trade's WETH-leg size, in USD. $1,000 is a starting
// point for an early-stage/low-liquidity board; tune freely, it's read from
// nowhere else.
export const LARGE_BUY_USD_THRESHOLD = 1_000;

// Cap on how many rows the rail keeps in memory/renders — a live feed that
// runs for hours shouldn't grow unbounded.
export const RAIL_MAX_EVENTS = 100;

export type RailEventKind = "LAUNCH" | "GRADUATED" | "BURN" | "BUY";

export type RailEvent = {
  kind: RailEventKind;
  key: string; // txHash-logIndex, for React keys / de-dup
  txHash: Hex;
  blockNumber: bigint;
  timestamp?: number; // unix seconds, filled in async — the row still shows without it
  token?: Address;
  symbol?: string;
  amountUsd?: number;
};

// PoolManager's Swap event reports amount0/amount1 as the balance delta TO THE
// POOL — positive means the trader gave the pool that currency. This still
// assumes token=currency0/WETH=currency1 unconditionally, true for every pool
// that exists today (BallastSeeder only supports that ordering — see
// lib/pool.ts's tokenIsCurrency0/buyZeroForOne/sellZeroForOne, which DERIVE the
// side per pool rather than assume it). A buy (spend WETH, receive token) has
// amount1 > 0 (pool received WETH) and amount0 < 0 (pool paid out token).
// TODO once a non-WETH-quote or token-is-currency1 pool can actually exist:
// this function needs the pool's real ordering passed in rather than assuming
// it, the same generalization lib/pool.ts already went through.
export function classifySwap(amount1: bigint): "buy" | "sell" {
  return amount1 > 0n ? "buy" : "sell";
}

export function swapUsdSize(amount1: bigint, ethUsd1e18: bigint): number {
  const abs = amount1 < 0n ? -amount1 : amount1;
  return (Number(abs) / 1e18) * (Number(ethUsd1e18) / 1e18);
}
