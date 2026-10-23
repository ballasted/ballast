import { describe, it, expect } from "vitest";
import { classifySwap } from "./swapDirection";

// REAL on-chain swaps from Robinhood Chain (chain 4663), pulled by
// scripts/tg-fetch-swap-fixtures.mjs. Each `side` here is ground truth derived
// INDEPENDENTLY of the sign convention under test — from the net ERC-20 movement
// of the launched token in/out of the v4 PoolManager singleton in that same tx
// (pool gained the token ⇒ swapper paid it ⇒ sell; pool lost it ⇒ buy). The four
// fixtures span the full matrix: launched token as currency0 and as currency1,
// each with a buy and a sell — exactly the cases the old (inverted) code got
// wrong.
const FIXTURES = [
  {
    name: "token is currency1 — SELL",
    txHash: "0x6f9fcb4399db85f7a6939cb9c9629ce30b557995486bc8023aea1d46b0bdb302",
    token: "0xf7e04472be047263885480dab2c42ab75b1386c1",
    quote: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    amount0: 2425261209401158n,
    amount1: -2368931182545148840955895n,
    side: "sell" as const,
  },
  {
    name: "token is currency1 — BUY",
    txHash: "0x6be47598d53b274a2096661846d6fbd4a8b858611e44a37e655b422b74114930",
    token: "0xa9b587b4945c587455ad28c16b032e0034db3a44",
    quote: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c",
    amount0: -137016306504567469n,
    amount1: 106974117337655468910212028n,
    side: "buy" as const,
  },
  {
    name: "token is currency0 — SELL",
    txHash: "0xdd9ca509c91d26dce144fce82202aebc37838e1649d97ef057313879eb088056",
    token: "0x3fec2b548755d53fd8db97cac0c14dfa99f0e335",
    quote: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    amount0: -952848975996092491257541n,
    amount1: 11310444512766551n,
    side: "sell" as const,
  },
  {
    name: "token is currency0 — BUY",
    txHash: "0x89edade339d06ddf8e03482b13254c172b257878e7d18758387eafd81abf1e9f",
    token: "0x3fec2b548755d53fd8db97cac0c14dfa99f0e335",
    quote: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    amount0: 952848975996092491257541n,
    amount1: -11310444512766552n,
    side: "buy" as const,
  },
];

describe("classifySwap — matches ground truth on real on-chain swaps", () => {
  for (const f of FIXTURES) {
    it(`${f.name} (${f.txHash.slice(0, 10)})`, () => {
      const c = classifySwap(f.token as `0x${string}`, f.quote as `0x${string}`, f.amount0, f.amount1);
      expect(c.side).toBe(f.side);

      // currency order is by ascending address
      expect(c.tokenIsCurrency0).toBe(f.token.toLowerCase() < f.quote.toLowerCase());

      // amounts shown are the magnitudes of each side's delta
      const tokenDelta = c.tokenIsCurrency0 ? f.amount0 : f.amount1;
      const quoteDelta = c.tokenIsCurrency0 ? f.amount1 : f.amount0;
      expect(c.tokenAbs).toBe(tokenDelta < 0n ? -tokenDelta : tokenDelta);
      expect(c.quoteAbs).toBe(quoteDelta < 0n ? -quoteDelta : quoteDelta);
    });
  }

  it("the OLD convention (buy = positive WETH/quote delta) was inverted on every fixture", () => {
    // Regression guard: proves the fix flipped direction. The old code did
    // `side = quoteDelta > 0 ? "buy" : "sell"` — the opposite of the truth.
    for (const f of FIXTURES) {
      const c = classifySwap(f.token as `0x${string}`, f.quote as `0x${string}`, f.amount0, f.amount1);
      const quoteDelta = c.tokenIsCurrency0 ? f.amount1 : f.amount0;
      const oldSide = quoteDelta > 0n ? "buy" : "sell";
      expect(oldSide).not.toBe(c.side);
    }
  });
});
