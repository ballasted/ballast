import { describe, it, expect } from "vitest";
import { routeRevertReason, needsBuybackWire, needsParentWire, effectiveSplit, effectiveSplitParts } from "./feeRouter";

const GEN4 = { creatorPct: 80, platformPct: 20, referrerPct: 0 };

describe("effectiveSplit", () => {
  it("Custom 50/0/25/0/25 on gen-4 80/20/0 → 40/0/20/0/20 + 20 platform", () => {
    const e = effectiveSplit(GEN4, { creatorBps: 5000, treasuryBps: 0, buybackBps: 2500, parentBurnBps: 0, rewardsBps: 2500 });
    expect(e).toEqual({ creator: 40, treasury: 0, buyback: 20, parentBurn: 0, stakers: 20, platform: 20, referrer: 0 });
  });

  it("'All to me' (100% creator) → 80 creator / 20 platform", () => {
    const e = effectiveSplit(GEN4, { creatorBps: 10000, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 });
    expect(e).toEqual({ creator: 80, treasury: 0, buyback: 0, parentBurn: 0, stakers: 0, platform: 20, referrer: 0 });
  });

  it("parentBurn 5th bucket: 50/0/0/50/0 → creator 40 · parentBurn 40 · platform 20", () => {
    const e = effectiveSplit(GEN4, { creatorBps: 5000, treasuryBps: 0, buybackBps: 0, parentBurnBps: 5000, rewardsBps: 0 });
    expect(e).toEqual({ creator: 40, treasury: 0, buyback: 0, parentBurn: 40, stakers: 0, platform: 20, referrer: 0 });
  });

  it("always sums to exactly 100, even with ugly 5-bucket rounding", () => {
    const combos = [
      { creatorBps: 3333, treasuryBps: 0, buybackBps: 3333, parentBurnBps: 0, rewardsBps: 3334 },
      { creatorBps: 1, treasuryBps: 0, buybackBps: 1, parentBurnBps: 1, rewardsBps: 9997 },
      { creatorBps: 100, treasuryBps: 0, buybackBps: 3300, parentBurnBps: 3300, rewardsBps: 3300 },
      { creatorBps: 2001, treasuryBps: 0, buybackBps: 2666, parentBurnBps: 2666, rewardsBps: 2667 },
      { creatorBps: 10000, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 },
    ];
    for (const r of combos) {
      const e = effectiveSplit(GEN4, r);
      const sum = e.creator + e.treasury + e.buyback + e.parentBurn + e.stakers + e.platform + e.referrer;
      expect(sum).toBe(100);
    }
  });

  it("respects a non-zero referrer share and a different platform cut", () => {
    const e = effectiveSplit({ creatorPct: 50, platformPct: 35, referrerPct: 15 }, { creatorBps: 10000, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 });
    expect(e.creator + e.platform + e.referrer).toBe(100);
    expect(e.platform).toBe(35);
    expect(e.referrer).toBe(15);
  });
});

describe("effectiveSplitParts", () => {
  it("hides 0% buckets and keeps order, summing to 100", () => {
    const parts = effectiveSplitParts(GEN4, { creatorBps: 5000, treasuryBps: 0, buybackBps: 2500, parentBurnBps: 0, rewardsBps: 2500 });
    expect(parts.map((p) => p.key)).toEqual(["creator", "buyback", "stakers", "platform"]);
    expect(parts.reduce((s, p) => s + p.pct, 0)).toBe(100);
    // Every part carries a colour class so the row matches the split bar.
    expect(parts.every((p) => p.color.startsWith("bg-"))).toBe(true);
  });

  it("surfaces the parentBurn bucket when non-zero", () => {
    const parts = effectiveSplitParts(GEN4, { creatorBps: 5000, treasuryBps: 0, buybackBps: 0, parentBurnBps: 5000, rewardsBps: 0 });
    expect(parts.map((p) => p.key)).toEqual(["creator", "parentBurn", "platform"]);
  });
});

describe("needsParentWire", () => {
  it("false with no parent", () => {
    expect(needsParentWire({ hasParent: false, parentWired: false, parentBurnBps: 5000, hasPendingSplit: false, pendingParentBurnBps: 0 })).toBe(false);
  });
  it("true when parent burn is active but pool unwired", () => {
    expect(needsParentWire({ hasParent: true, parentWired: false, parentBurnBps: 5000, hasPendingSplit: false, pendingParentBurnBps: 0 })).toBe(true);
  });
  it("false once wired", () => {
    expect(needsParentWire({ hasParent: true, parentWired: true, parentBurnBps: 5000, hasPendingSplit: false, pendingParentBurnBps: 0 })).toBe(false);
  });
});

describe("routeRevertReason", () => {
  it("NothingToRoute → explains no fees yet (the smoke-test case)", () => {
    expect(routeRevertReason("NothingToRoute", 1000, 0)).toMatch(/no fees to route yet/i);
  });
  it("Cooldown → countdown when readyAt is in the future", () => {
    const msg = routeRevertReason("Cooldown", 1000, 1120);
    expect(msg).toMatch(/cooldown/i);
    expect(msg).toMatch(/ready in/i);
  });
  it("Cooldown → no countdown once readyAt has passed", () => {
    expect(routeRevertReason("Cooldown", 1000, 900)).toBe("On cooldown.");
  });
  it("MinAmountOutNotMet → slippage hint", () => {
    expect(routeRevertReason("MinAmountOutNotMet", 1000, 0)).toMatch(/price too far|slippage|try again/i);
  });
  it("unknown / undefined → generic, never a false 'Ready'", () => {
    expect(routeRevertReason(undefined, 1000, 0)).toMatch(/can't route/i);
    expect(routeRevertReason("Weird", 1000, 0)).toMatch(/Weird/);
  });
});

describe("needsBuybackWire", () => {
  it("true when buyback is active but the pool isn't wired", () => {
    expect(needsBuybackWire({ buybackWired: false, buybackBps: 2500, hasPendingSplit: false, pendingBuybackBps: 0 })).toBe(true);
  });
  it("true when a SCHEDULED split will route to buyback (the smoke-test case)", () => {
    expect(needsBuybackWire({ buybackWired: false, buybackBps: 0, hasPendingSplit: true, pendingBuybackBps: 3500 })).toBe(true);
  });
  it("false once the pool is wired", () => {
    expect(needsBuybackWire({ buybackWired: true, buybackBps: 2500, hasPendingSplit: true, pendingBuybackBps: 3500 })).toBe(false);
  });
  it("false when no buyback bucket is used", () => {
    expect(needsBuybackWire({ buybackWired: false, buybackBps: 0, hasPendingSplit: false, pendingBuybackBps: 0 })).toBe(false);
  });
});
