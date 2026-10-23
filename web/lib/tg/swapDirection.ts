// Pure buy/sell classification for a Uniswap-v4 Swap event. No I/O, no secrets —
// fixture-tested against real on-chain txs (swapDirection.test.ts).
//
// THE BUG THIS FIXES: the alert bot previously derived direction from the sign of
// the WETH delta using the v3 pool-balance convention (`wethDelta > 0 => buy`).
// Uniswap v4's Swap event emits amount0/amount1 as deltas FROM THE SWAPPER'S
// SIDE: negative = the swapper PAID that currency, positive = the swapper
// RECEIVED it. So a positive WETH delta means the swapper received WETH — i.e.
// they SOLD the launched token — which the old code mislabelled as a buy. Every
// buy was posted as a sell and vice-versa.
//
// The robust definition, independent of which currency WETH is: a BUY is when the
// swapper RECEIVED the launched token (its delta is positive); a SELL is when the
// swapper PAID the launched token (its delta is negative). We also return the
// absolute amounts so the message shows magnitudes regardless of sign.

import type { Address } from "viem";

export type SwapSide = "buy" | "sell";

export type SwapClassification = {
  side: SwapSide;
  /** Which currency slot the launched token occupies in the PoolKey. */
  tokenIsCurrency0: boolean;
  /** Absolute launched-token amount moved (raw, token decimals). */
  tokenAbs: bigint;
  /** Absolute quote-asset amount moved (raw, quote decimals). */
  quoteAbs: bigint;
};

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/**
 * Classify a v4 Swap by the launched token vs. the pool's quote asset.
 *
 * @param token       the launched token address
 * @param quoteAsset  the other currency in the pool (e.g. WETH)
 * @param amount0     v4 Swap.amount0 (swapper-perspective delta of currency0)
 * @param amount1     v4 Swap.amount1 (swapper-perspective delta of currency1)
 *
 * Currency order in a v4 PoolKey is by ascending address, so the token is
 * currency0 iff its address sorts below the quote asset's.
 */
export function classifySwap(
  token: Address,
  quoteAsset: Address,
  amount0: bigint,
  amount1: bigint,
): SwapClassification {
  const tokenIsCurrency0 = token.toLowerCase() < quoteAsset.toLowerCase();
  const tokenDelta = tokenIsCurrency0 ? amount0 : amount1;
  const quoteDelta = tokenIsCurrency0 ? amount1 : amount0;
  // Buy = swapper received the launched token (positive delta from their side).
  const side: SwapSide = tokenDelta > 0n ? "buy" : "sell";
  return { side, tokenIsCurrency0, tokenAbs: abs(tokenDelta), quoteAbs: abs(quoteDelta) };
}
