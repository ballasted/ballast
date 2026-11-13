// Uniswap v3/v4 TickMath + LiquidityAmounts, ported to bigint. Used to place
// single-tick range-order limit orders on the gen-5 hook (BallastHookV5.place takes
// a tickLower + liquidity; the UI thinks in price + input amount). All math mirrors
// the canonical Solidity so a placed order sits at exactly the intended price.

const Q96 = 1n << 96n;
const UINT256_MAX = (1n << 256n) - 1n;

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** sqrtPriceX96 at a tick — byte-for-byte the Solidity TickMath.getSqrtRatioAtTick. */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(tick < 0 ? -tick : tick);
  if (absTick > BigInt(MAX_TICK)) throw new Error("tick out of range");

  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const m = (c: bigint) => {
    ratio = (ratio * c) >> 128n;
  };
  if ((absTick & 0x2n) !== 0n) m(0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4n) !== 0n) m(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8n) !== 0n) m(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10n) !== 0n) m(0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20n) !== 0n) m(0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40n) !== 0n) m(0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80n) !== 0n) m(0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100n) !== 0n) m(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200n) !== 0n) m(0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400n) !== 0n) m(0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800n) !== 0n) m(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000n) !== 0n) m(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000n) !== 0n) m(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000n) !== 0n) m(0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000n) !== 0n) m(0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000n) !== 0n) m(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000n) !== 0n) m(0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000n) !== 0n) m(0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000n) !== 0n) m(0x48a170391f7dc42444e8fa2n);

  if (tick > 0) ratio = UINT256_MAX / ratio;

  // sqrtPriceX96 = ratio >> 32, rounded up if any low bits are set.
  return (ratio >> 32n) + ((ratio & ((1n << 32n) - 1n)) === 0n ? 0n : 1n);
}

/** Nearest usable tick for a human price `quotePerToken` (both sides 18-decimal on
 *  Ballast pools), given whether the token sorts as currency0, aligned DOWN to
 *  `spacing`. Price → raw ratio currency1/currency0 → tick via log base 1.0001. */
export function tickForPrice(quotePerToken: number, tokenIsCurrency0: boolean, spacing: number): number {
  if (!(quotePerToken > 0)) throw new Error("price must be positive");
  // raw ratio currency1/currency0. Both currencies are 18-decimal here, so the raw
  // ratio equals the whole-unit ratio.
  const ratio = tokenIsCurrency0 ? quotePerToken : 1 / quotePerToken;
  const tick = Math.log(ratio) / Math.log(1.0001);
  const aligned = Math.floor(tick / spacing) * spacing;
  return Math.max(MIN_TICK, Math.min(MAX_TICK, aligned));
}

/** Liquidity for `amount0` deposited across [tickLower, tickUpper]. */
export function liquidityForAmount0(amount0: bigint, sqrtA: bigint, sqrtB: bigint): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (hi === lo) return 0n;
  // L = amount0 * (lo*hi/Q96) / (hi - lo)
  const intermediate = (lo * hi) / Q96;
  return (amount0 * intermediate) / (hi - lo);
}

/** Liquidity for `amount1` deposited across [tickLower, tickUpper]. */
export function liquidityForAmount1(amount1: bigint, sqrtA: bigint, sqrtB: bigint): bigint {
  const [lo, hi] = sqrtA < sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (hi === lo) return 0n;
  // L = amount1 * Q96 / (hi - lo)
  return (amount1 * Q96) / (hi - lo);
}
