import { describe, it, expect } from "vitest";
import {
  tokenIsCurrency0,
  poolKeyForToken,
  buyZeroForOne,
  sellZeroForOne,
  tokenPriceInQuote,
} from "./pool";

const TOKEN_LOW = "0x1000000000000000000000000000000000000001" as const;
const TOKEN_HIGH = "0xf000000000000000000000000000000000000001" as const;
const QUOTE = "0x5000000000000000000000000000000000000001" as const; // between the two above
const HOOK = "0x9999999999999999999999999999999999999999" as const;

describe("tokenIsCurrency0 / ordering", () => {
  it("token below quote sorts as currency0", () => {
    expect(tokenIsCurrency0(TOKEN_LOW, QUOTE)).toBe(true);
  });
  it("token above quote sorts as currency1", () => {
    expect(tokenIsCurrency0(TOKEN_HIGH, QUOTE)).toBe(false);
  });
});

describe("poolKeyForToken", () => {
  it("puts the lower address in currency0 regardless of which one is the token", () => {
    const keyLow = poolKeyForToken(TOKEN_LOW, QUOTE, HOOK)!;
    expect(keyLow.currency0).toBe(TOKEN_LOW);
    expect(keyLow.currency1).toBe(QUOTE);

    const keyHigh = poolKeyForToken(TOKEN_HIGH, QUOTE, HOOK)!;
    expect(keyHigh.currency0).toBe(QUOTE);
    expect(keyHigh.currency1).toBe(TOKEN_HIGH);
  });
});

describe("buyZeroForOne / sellZeroForOne", () => {
  it("token-as-currency0: buying is 1->0, selling is 0->1", () => {
    expect(buyZeroForOne(TOKEN_LOW, QUOTE)).toBe(false);
    expect(sellZeroForOne(TOKEN_LOW, QUOTE)).toBe(true);
  });
  it("token-as-currency1: directions flip", () => {
    expect(buyZeroForOne(TOKEN_HIGH, QUOTE)).toBe(true);
    expect(sellZeroForOne(TOKEN_HIGH, QUOTE)).toBe(false);
  });
  it("buy and sell are always opposite for the same pair", () => {
    expect(buyZeroForOne(TOKEN_LOW, QUOTE)).toBe(!sellZeroForOne(TOKEN_LOW, QUOTE));
    expect(buyZeroForOne(TOKEN_HIGH, QUOTE)).toBe(!sellZeroForOne(TOKEN_HIGH, QUOTE));
  });
});

// sqrtPriceX96 for a clean raw ratio of 4 (currency1raw/currency0raw = 4):
// sqrtPriceX96 = sqrt(4) * 2^96 = 2 * 2^96, chosen so the intermediate math has
// no rounding — isolates the decimals/ordering logic from sqrt-precision noise.
const SQRT_PRICE_RATIO_4 = 2n * (1n << 96n);

describe("tokenPriceInQuote", () => {
  it("token=currency0, 18-decimal quote (WETH-equivalent): matches the raw ratio directly — this is the exact pre-generalization behavior", () => {
    // rawRatioWad = 4 * 1e18; quoteDecimals=18 must be a no-op multiplier.
    expect(tokenPriceInQuote(SQRT_PRICE_RATIO_4, true, 18)).toBe(4n * 10n ** 18n);
  });

  it("token=currency0, 6-decimal quote (USDC-shaped): scales up by 10^12", () => {
    // Hand-derived: quoteRaw/tokenRaw=4, token 18-dec, quote 6-dec =>
    // quoteWhole/tokenWhole = 4 * 1e12 => priceWAD = 4e12 * 1e18 = 4e30.
    expect(tokenPriceInQuote(SQRT_PRICE_RATIO_4, true, 6)).toBe(4n * 10n ** 30n);
  });

  it("token=currency1, 18-decimal quote: inverts the ratio", () => {
    // tokenRaw/quoteRaw=4 (both 18-dec) => quoteWhole/tokenWhole=0.25 => 2.5e17.
    expect(tokenPriceInQuote(SQRT_PRICE_RATIO_4, false, 18)).toBe(25n * 10n ** 16n);
  });

  it("token=currency1, 6-decimal quote: inverts AND applies the decimals term", () => {
    // tokenRaw/quoteRaw=4, token 18-dec, quote 6-dec =>
    // quoteWhole/tokenWhole = 1e18/(4*1e6) = 2.5e11 => priceWAD = 2.5e11*1e18 = 2.5e29.
    expect(tokenPriceInQuote(SQRT_PRICE_RATIO_4, false, 6)).toBe(25n * 10n ** 28n);
  });

  it("18-decimal quote is a fixed point of the ordering choice for a self-inverse ratio (raw ratio 1, i.e. sqrtPriceX96 = 2^96)", () => {
    const sqrtPriceRatio1 = 1n << 96n;
    // rawRatioWad = 1e18 either way; token=currency0 gives 1e18 directly,
    // token=currency1 gives 1e36/1e18 = 1e18 — both sides must agree here.
    expect(tokenPriceInQuote(sqrtPriceRatio1, true, 18)).toBe(10n ** 18n);
    expect(tokenPriceInQuote(sqrtPriceRatio1, false, 18)).toBe(10n ** 18n);
  });

  it("zero price never throws, returns 0", () => {
    expect(tokenPriceInQuote(0n, true, 18)).toBe(0n);
    expect(tokenPriceInQuote(0n, false, 6)).toBe(0n);
  });
});
