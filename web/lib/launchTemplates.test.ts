import { describe, it, expect } from "vitest";
import { LAUNCH_TEMPLATES, availableTemplates, type LiveContext } from "./launchTemplates";

const ctx = (over: Partial<LiveContext> = {}): LiveContext => ({
  availableTickers: new Set(["WETH", "NVDA", "SGOV"]),
  feeRouterActive: true,
  feeRouterV2Active: true,
  ...over,
});

describe("launch templates config", () => {
  it("every split sums to 10000 and keeps the treasury fee bucket at 0", () => {
    for (const t of LAUNCH_TEMPLATES) {
      const s = t.plan.split;
      expect(s.creatorBps + s.treasuryBps + s.buybackBps + s.parentBurnBps + s.rewardsBps).toBe(10000);
      expect(s.treasuryBps).toBe(0);
    }
  });
  it("a parent-burn template declares its FeeRouter v2 requirement", () => {
    for (const t of LAUNCH_TEMPLATES) {
      if (t.plan.split.parentBurnBps > 0) expect(t.requires.feeRouterV2).toBe(true);
    }
  });
  it("blurbs carry no banned copy", () => {
    const banned = /\b(floor|guaranteed|safe|yield|reward|APR|cashback|dividend)\b/i;
    for (const t of LAUNCH_TEMPLATES) expect(t.blurb).not.toMatch(banned);
  });
});

describe("availableTemplates gating", () => {
  it("offers all when everything is live", () => {
    expect(availableTemplates(ctx()).map((t) => t.key)).toEqual(["ai", "cash-like", "burn-heavy", "community", "family"]);
  });
  it("hides AI when NVDA is not allowlisted", () => {
    const keys = availableTemplates(ctx({ availableTickers: new Set(["WETH", "SGOV"]) })).map((t) => t.key);
    expect(keys).not.toContain("ai");
    expect(keys).toContain("cash-like");
  });
  it("hides Cash-like when SGOV is not allowlisted", () => {
    expect(availableTemplates(ctx({ availableTickers: new Set(["WETH", "NVDA"]) })).map((t) => t.key)).not.toContain("cash-like");
  });
  it("hides Family when FeeRouter v2 is inactive", () => {
    expect(availableTemplates(ctx({ feeRouterV2Active: false })).map((t) => t.key)).not.toContain("family");
  });
  it("hides split templates when no FeeRouter is configured", () => {
    const keys = availableTemplates(ctx({ feeRouterActive: false, feeRouterV2Active: false })).map((t) => t.key);
    expect(keys).toEqual(["cash-like"]); // only the 100%-creator treasury template survives
  });
});
