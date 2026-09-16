import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { HOOK_ADDRESS, HOOK_ADDRESSES, TICK_SPACING } from "./contracts";

// A BALLAST pool is token/quoteAsset, fee 0 (the hook takes the fee on the quote
// leg), tickSpacing 60, and the singleton hook for that launch's generation.
// Every quote asset today is WETH (BallastFactory.launch() rejects anything
// else — QuoteAssetNotSupportedYet), but `quoteAsset` is a real, required
// parameter everywhere below rather than a hardcoded WETH import: ordering is
// derived per call, never assumed, so a caller can't silently keep the old
// "token is always currency0" belief once other quote assets land. See
// contracts/src/libraries/OrderingLib.sol for the same principle on-chain.
export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/** True if `token` sorts as currency0 once paired against `quoteAsset`. */
export function tokenIsCurrency0(token: Address, quoteAsset: Address): boolean {
  return token.toLowerCase() < quoteAsset.toLowerCase();
}

// The pool key for a token/quoteAsset pair under a SPECIFIC hook (defaults to the
// current one). The hook is part of the PoolKey and is fixed per pool at
// graduation, so a token launched under a prior hook must be keyed with THAT
// hook — pass it explicitly (see candidatePoolKeys / the hook resolver) rather
// than assuming the current one.
export function poolKeyForToken(
  token: Address,
  quoteAsset: Address,
  hook: Address | undefined = HOOK_ADDRESS,
): PoolKey | undefined {
  if (!hook) return undefined;
  const [c0, c1] = tokenIsCurrency0(token, quoteAsset) ? [token, quoteAsset] : [quoteAsset, token];
  return {
    currency0: c0,
    currency1: c1,
    fee: 0,
    tickSpacing: TICK_SPACING,
    hooks: hook,
  };
}

// Every candidate (hook, key, poolId) for a token, newest hook first. A token's pool
// lives under exactly ONE of these — the resolver probes pool state and picks the
// live one, so prior-hook tokens keep resolving after a hook redeploy.
export function candidatePoolKeys(token: Address, quoteAsset: Address): { hook: Address; key: PoolKey; id: Hex }[] {
  const out: { hook: Address; key: PoolKey; id: Hex }[] = [];
  for (const hook of HOOK_ADDRESSES) {
    const key = poolKeyForToken(token, quoteAsset, hook);
    if (key) out.push({ hook, key, id: poolId(key) });
  }
  return out;
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

/** zeroForOne for BUYING `token` (spending the quote asset to receive it). */
export function buyZeroForOne(token: Address, quoteAsset: Address): boolean {
  return !tokenIsCurrency0(token, quoteAsset); // spending currency1 for currency0
}

/** zeroForOne for SELLING `token` (spending it to receive the quote asset). */
export function sellZeroForOne(token: Address, quoteAsset: Address): boolean {
  return tokenIsCurrency0(token, quoteAsset); // spending currency0 for currency1
}

/**
 * Spot price of `token` in whole units of `quoteAsset`, 1e18-scaled, from
 * sqrtPriceX96. Correct regardless of which side sorts as currency0, and
 * regardless of the quote asset's own decimals (the token side is always
 * 18-decimal — Ballast's own token, constrained by construction).
 *
 * Uniswap's sqrtPriceX96 encodes RAW-unit currency1/currency0 — that's only
 * directly "quote-per-token, 1e18" when quoteAsset happens to be both
 * currency1 AND 18-decimal (WETH, today). The old single-quote-asset version
 * of this function returned that raw ratio unconditionally; this generalizes
 * both axes explicitly rather than assuming them.
 */
export function tokenPriceInQuote(sqrtPriceX96: bigint, tokenIsCurrency0Side: boolean, quoteDecimals: number): bigint {
  // Raw ratio currency1/currency0, 1e18 fixed point: (sqrt^2 * 1e18) >> 192.
  const rawRatioWad = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n;
  if (tokenIsCurrency0Side) {
    // rawRatioWad = quoteRaw/tokenRaw, WAD. Token is always 18-decimal, so the
    // whole-unit price = rawRatioWad * 10^(18 - quoteDecimals); quoteDecimals in
    // [0,18] keeps the exponent non-negative.
    return rawRatioWad * 10n ** BigInt(18 - quoteDecimals);
  }
  // Token is currency1: rawRatioWad = tokenRaw/quoteRaw (inverted relative to what
  // we want). Invert AND apply the decimals term in one division to avoid an
  // intermediate that could itself round to zero: 10^(54-quoteDecimals) keeps the
  // exponent in [36,54], always non-negative for quoteDecimals in [0,18].
  if (rawRatioWad === 0n) return 0n;
  return 10n ** BigInt(54 - quoteDecimals) / rawRatioWad;
}
