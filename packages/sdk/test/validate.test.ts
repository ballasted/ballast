import { describe, it, expect } from "vitest";
import { validateFeeSplit, isInstantSplitChange, splitsEqual, SplitShapeError, ValidationError, type FeeSplit } from "../src";

const split = (p: Partial<FeeSplit>): FeeSplit => ({ creatorBps: 0, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0, ...p });

describe("validateFeeSplit", () => {
  it("accepts a 100%-creator split", () => {
    expect(() => validateFeeSplit(split({ creatorBps: 10000 }))).not.toThrow();
  });
  it("accepts 50/25/25 creator/buyback/rewards", () => {
    expect(() => validateFeeSplit(split({ creatorBps: 5000, buybackBps: 2500, rewardsBps: 2500 }))).not.toThrow();
  });
  it("rejects a split that doesn't sum to 10000", () => {
    expect(() => validateFeeSplit(split({ creatorBps: 5000, buybackBps: 2000 }))).toThrow(SplitShapeError);
  });
  it("rejects a bucket out of range", () => {
    expect(() => validateFeeSplit(split({ creatorBps: 10001 }))).toThrow(SplitShapeError);
    expect(() => validateFeeSplit(split({ creatorBps: -1, rewardsBps: 10001 }))).toThrow(SplitShapeError);
  });
  it("rejects treasuryBps > 0 at launch (treasury bucket disabled)", () => {
    expect(() => validateFeeSplit(split({ creatorBps: 5000, treasuryBps: 5000 }))).toThrow(SplitShapeError);
  });
  it("allows treasuryBps when explicitly enabled", () => {
    expect(() => validateFeeSplit(split({ creatorBps: 5000, treasuryBps: 5000 }), { allowTreasury: true })).not.toThrow();
  });
  it("rejects parentBurnBps > 0 with no parent", () => {
    expect(() => validateFeeSplit(split({ creatorBps: 9000, parentBurnBps: 1000 }))).toThrow(ValidationError);
  });
  it("accepts parentBurnBps > 0 with a parent", () => {
    expect(() => validateFeeSplit(split({ creatorBps: 9000, parentBurnBps: 1000 }), { parent: "0xDc605041F02e41CbD8FDC347023e93C4c3fA243C" })).not.toThrow();
  });
});

describe("isInstantSplitChange (asymmetric delay)", () => {
  const cur = split({ creatorBps: 8000, buybackBps: 2000 });
  it("INSTANT when lowering creator and raising buyback", () => {
    expect(isInstantSplitChange(cur, split({ creatorBps: 5000, buybackBps: 5000 }))).toBe(true);
  });
  it("INSTANT when creator unchanged, buyback→rewards shift keeps buckets non-decreasing only if so", () => {
    // Lowering buyback (2000→1000) while raising rewards is NOT instant: a bucket dropped.
    expect(isInstantSplitChange(cur, split({ creatorBps: 8000, buybackBps: 1000, rewardsBps: 1000 }))).toBe(false);
  });
  it("DELAYED when raising the creator share", () => {
    expect(isInstantSplitChange(cur, split({ creatorBps: 9000, buybackBps: 1000 }))).toBe(false);
  });
  it("INSTANT when identical (no bucket lowered, creator not raised)", () => {
    expect(isInstantSplitChange(cur, { ...cur })).toBe(true);
  });
});

describe("splitsEqual", () => {
  it("true for identical", () => {
    expect(splitsEqual(split({ creatorBps: 10000 }), split({ creatorBps: 10000 }))).toBe(true);
  });
  it("false when any bucket differs", () => {
    expect(splitsEqual(split({ creatorBps: 10000 }), split({ creatorBps: 9000, buybackBps: 1000 }))).toBe(false);
  });
});
