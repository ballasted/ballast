import { describe, it, expect } from "vitest";
import { identityFlags, washLoopKeys, computeSwapFlags, type FlagContext, type RawSwap } from "./wash";

const A = (c: string) => `0x${c.repeat(40).slice(0, 40)}` as `0x${string}`;

const ctx: FlagContext = {
  creator: A("c"),
  treasury: A("d"),
  teamRecipients: new Set([A("e").toLowerCase()]),
  creatorFundedWallets: new Set([A("f").toLowerCase()]),
};

const mk = (over: Partial<RawSwap> & { txHash: string }): RawSwap => ({
  logIndex: 0,
  blockNumber: 1,
  blockTs: 1000,
  trader: A("1"),
  side: "buy",
  usd: 100,
  ...over,
});

describe("identityFlags", () => {
  it("flags creator, treasury, team recipient, creator-funded wallets", () => {
    expect(identityFlags(A("c"), ctx)).toContain("trader_is_creator");
    expect(identityFlags(A("d"), ctx)).toContain("trader_is_treasury");
    expect(identityFlags(A("e"), ctx)).toContain("trader_is_team_recipient");
    expect(identityFlags(A("f"), ctx)).toContain("trader_funded_by_creator");
    expect(identityFlags(A("1"), ctx)).toEqual([]);
  });
});

describe("washLoopKeys", () => {
  it("flags both legs of an opposite-side loop by one wallet within the window", () => {
    const X = A("2");
    const swaps = [
      mk({ txHash: "0x1", trader: X, side: "buy", blockTs: 1000 }),
      mk({ txHash: "0x2", trader: X, side: "sell", blockTs: 1000 + 1800 }), // within 1h
    ];
    const keys = washLoopKeys(swaps, 3600);
    expect(keys.has("0x1|0")).toBe(true);
    expect(keys.has("0x2|0")).toBe(true);
  });

  it("does not flag same-side repeats or loops outside the window", () => {
    const X = A("2");
    const sameSide = [
      mk({ txHash: "0x1", trader: X, side: "buy", blockTs: 1000 }),
      mk({ txHash: "0x2", trader: X, side: "buy", blockTs: 1500 }),
    ];
    expect(washLoopKeys(sameSide, 3600).size).toBe(0);

    const farApart = [
      mk({ txHash: "0x3", trader: X, side: "buy", blockTs: 1000 }),
      mk({ txHash: "0x4", trader: X, side: "sell", blockTs: 1000 + 7200 }), // 2h apart
    ];
    expect(washLoopKeys(farApart, 3600).size).toBe(0);
  });
});

describe("computeSwapFlags", () => {
  it("combines identity + wash flags and returns flagged keys only", () => {
    const X = A("2");
    const swaps = [
      mk({ txHash: "0x1", trader: ctx.creator, side: "buy", usd: 500 }), // identity
      mk({ txHash: "0x2", trader: X, side: "buy", blockTs: 1000 }), // wash leg
      mk({ txHash: "0x3", trader: X, side: "sell", blockTs: 1600 }), // wash leg
      mk({ txHash: "0x4", trader: A("7"), side: "buy" }), // clean
    ];
    const { flaggedSwaps, flaggedKeys } = computeSwapFlags(swaps, ctx, 3600);
    expect(flaggedKeys.has("0x1|0")).toBe(true);
    expect(flaggedKeys.has("0x2|0")).toBe(true);
    expect(flaggedKeys.has("0x3|0")).toBe(true);
    expect(flaggedKeys.has("0x4|0")).toBe(false);
    const creatorFlag = flaggedSwaps.find((s) => s.txHash === "0x1");
    expect(creatorFlag?.reasons).toContain("trader_is_creator");
  });
});
