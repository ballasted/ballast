import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { HOOK_ADDRESS, WETH_ADDRESS, TICK_SPACING } from "./contracts";

// A BALLAST pool is always token/WETH with the token mined to sort BELOW WETH
// (currency0), fee 0 (the hook takes the 1% WETH-leg fee), tickSpacing 60, and
// the singleton BallastHook. currency0/currency1 must be sorted ascending — the
// factory guarantees token < weth, so token is always currency0.
export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export function poolKeyForToken(token: Address): PoolKey | undefined {
  if (!HOOK_ADDRESS || !WETH_ADDRESS) return undefined;
  // Defensive: the factory mines token < weth, but never assume — sort anyway.
  const [c0, c1] =
    token.toLowerCase() < WETH_ADDRESS.toLowerCase()
      ? [token, WETH_ADDRESS]
      : [WETH_ADDRESS, token];
  return {
    currency0: c0,
    currency1: c1,
    fee: 0,
    tickSpacing: TICK_SPACING,
    hooks: HOOK_ADDRESS,
  };
}

const POOL_KEY_ABI = [
  {
    type: "tuple",
    components: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(POOL_KEY_ABI, [
      {
        currency0: key.currency0,
        currency1: key.currency1,
        fee: key.fee,
        tickSpacing: key.tickSpacing,
        hooks: key.hooks,
      },
    ]),
  );
}

// A BALLAST token is currency0 (below WETH). Buying the token spends WETH
// (currency1) for token (currency0): that is currency1 -> currency0, i.e.
// zeroForOne = false. Selling is the reverse: zeroForOne = true.
export const BUY_ZERO_FOR_ONE = false;
export const SELL_ZERO_FOR_ONE = true;

/**
 * Spot price of the token in WETH, 1e18-scaled, from sqrtPriceX96.
 * price(currency1/currency0) = (sqrtPriceX96 / 2^96)^2, and here currency0 is the
 * token, currency1 is WETH, so that ratio is WETH-per-token directly.
 */
export function priceFromSqrtX96(sqrtPriceX96: bigint): bigint {
  // (sqrt^2 * 1e18) >> 192, done in bigint to avoid float loss.
  return (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n;
}
