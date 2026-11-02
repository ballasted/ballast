import { describe, it, expect } from "vitest";
import { aggregateVolume, rawSwapFromDecoded, type DecodedSwap } from "./volume";
import { usdOfQuote } from "./pricing";
import type { RawSwap } from "./wash";
import type { QuoteFeed } from "./pricing";

const addr = (n: string) => `0x${n.repeat(40).slice(0, 40)}` as `0x${string}`;

const LAUNCH = 1_000; // launch ts
const mk = (over: Partial<RawSwap> & { txHash: string }): RawSwap => ({
  logIndex: 0,
  blockNumber: 1,
  blockTs: LAUNCH + 100,
  trader: addr("1"),
  side: "buy",
  usd: 1000,
  ...over,
});

describe("usdOfQuote", () => {
  it("values a quote amount at its token decimals × price", () => {
    expect(usdOfQuote(5n * 10n ** 18n, 18, 100)).toBeCloseTo(500, 6);
    expect(usdOfQuote(250n * 10n ** 6n, 6, 1)).toBeCloseTo(250, 6); // 6-dp quote
  });
});

describe("rawSwapFromDecoded", () => {
  const token = addr("a"); // sorts below quote → currency0
  const quote = addr("f");
  const feed: QuoteFeed = { asset: quote, feed: addr("b"), feedDecimals: 8, tokenDecimals: 18 };

  it("classifies a buy (token received) and prices the quote side", () => {
    const d: DecodedSwap = {
      txHash: "0x1",
      logIndex: 0,
      blockNumber: 1,
      blockTs: 1100,
      trader: addr("1"),
      token,
      quote,
      amount0: 10n * 10n ** 18n, // +token → buy
      amount1: -4n * 10n ** 18n, // −quote (paid)
    };
    const r = rawSwapFromDecoded(d, feed, 2.5);
    expect(r.side).toBe("buy");
    expect(r.usd).toBeCloseTo(10, 6); // 4 quote × $2.5
  });

  it("marks usd null when there is no feed/price (never 0)", () => {
    const d: DecodedSwap = {
      txHash: "0x2",
      logIndex: 1,
      blockNumber: 1,
      blockTs: 1100,
      trader: addr("1"),
      token,
      quote,
      amount0: -10n * 10n ** 18n,
      amount1: 4n * 10n ** 18n,
    };
    expect(rawSwapFromDecoded(d, undefined, undefined).usd).toBeNull();
    expect(rawSwapFromDecoded(d, feed, undefined).usd).toBeNull();
  });
});

describe("aggregateVolume", () => {
  const swaps: RawSwap[] = [
    mk({ txHash: "0x1", blockTs: 1100, usd: 20000 }),
    mk({ txHash: "0x2", blockTs: 1200, usd: 20000 }),
    mk({ txHash: "0x3", blockTs: 1300, usd: 20000 }), // cumulative 60k crosses 50k here
    mk({ txHash: "0x4", blockTs: 9_000_000, usd: 99999 }), // out of window
    mk({ txHash: "0x5", blockTs: 1400, usd: null }), // unpriced
  ];

  it("sums in-window priced volume and finds the first $50k crossing", () => {
    const r = aggregateVolume(swaps, LAUNCH, new Set());
    expect(r.rawVolumeUsd).toBe(60000);
    expect(r.volumeMilestoneReachedTs).toBe(1300);
    expect(r.unpricedCount).toBe(1);
  });

  it("subtracts flagged volume without changing the raw total", () => {
    const r = aggregateVolume(swaps, LAUNCH, new Set(["0x2|0"]));
    expect(r.rawVolumeUsd).toBe(60000);
    expect(r.flaggedVolumeUsd).toBe(20000);
    expect(r.volumeExcludingFlaggedUsd).toBe(40000);
  });

  it("never reports a milestone when volume stays under $50k", () => {
    const small = [mk({ txHash: "0xa", usd: 10000 }), mk({ txHash: "0xb", usd: 10000 })];
    expect(aggregateVolume(small, LAUNCH, new Set()).volumeMilestoneReachedTs).toBeNull();
  });

  it("excludes swaps outside the 14-day window from the total", () => {
    const r = aggregateVolume([mk({ txHash: "0xz", blockTs: 9_000_000, usd: 100000 })], LAUNCH, new Set());
    expect(r.rawVolumeUsd).toBe(0);
    expect(r.volumeMilestoneReachedTs).toBeNull();
  });
});
