// Honest pool-depth disclosure for low-FDV launches. A BALLAST unbacked launch
// opens at ~1 ETH fully diluted, so the token/WETH pool is thin: a small amount of
// net buying moves the published price a lot. We don't hide the price or the chart
// — we state the depth plainly, the same discipline as the backing panel.

// WETH (currency1) needed to raise the pool price by a factor k, entirely within the
// current active liquidity: Δy = L·(√(k·P) − √P) = L·√P·(√k − 1), with √P =
// sqrtPriceX96 / 2^96. For a wide one-sided seeded range L is constant across the
// move, so this is exact until the range boundary. We report the 2× figure — the
// same "(√2−1)·FDV" the launch math uses (~0.41 ETH at a 1 ETH opening).
const SQRT2_MINUS_1_NUM = 41421356237n; // (√2 − 1) × 1e11
const SQRT2_MINUS_1_DEN = 100000000000n;
const Q96 = 1n << 96n;
const WAD2 = 10n ** 36n;

/** USD of net buying needed to double the pool price, or undefined if not computable. */
export function usdToDoublePrice(
  liquidity: bigint | undefined,
  sqrtPriceX96: bigint | undefined,
  ethUsd1e18: bigint | undefined,
): number | undefined {
  if (!liquidity || !sqrtPriceX96 || !ethUsd1e18) return undefined;
  if (liquidity <= 0n || sqrtPriceX96 <= 0n || ethUsd1e18 <= 0n) return undefined;
  // Δy in WETH wei, then to USD cents (keep the cents so a sub-dollar depth isn't
  // floored to $0): (WETH wei × USD/ETH-1e18 × 100) / 1e36.
  const dyWei = (liquidity * sqrtPriceX96 * SQRT2_MINUS_1_NUM) / (SQRT2_MINUS_1_DEN * Q96);
  const cents = (dyWei * ethUsd1e18 * 100n) / WAD2;
  return Number(cents) / 100;
}

// Below this USD-to-double, a launch is thin enough that a few hundred dollars moves
// the price materially — worth stating on the card and the token page. A 1 ETH
// opening (~0.41 ETH ≈ a few hundred USD to double) is, by design, below it.
export const THIN_LIQUIDITY_USD = 2500;

export function isThinLiquidity(depthToDoubleUsd: number | undefined): boolean {
  return depthToDoubleUsd !== undefined && depthToDoubleUsd < THIN_LIQUIDITY_USD;
}
