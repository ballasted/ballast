import { describe, it, expect } from "vitest";
import { PRESETS, resolvePreset, availablePresets, type QuoteAssetCandidateLike } from "./launchTemplates";

const WETH = "0x0000000000000000000000000000000000dEaD" as const;
const NVDA = "0x1000000000000000000000000000000000000001" as const;
const SGOV = "0x2000000000000000000000000000000000000002" as const;
const SPY = "0x3000000000000000000000000000000000000003" as const;

function candidate(address: `0x${string}`, symbol: string, isGreen: boolean, isWeth = false): QuoteAssetCandidateLike {
  return { address, symbol, isWeth, isGreen };
}

describe("resolvePreset", () => {
  const allGreen: QuoteAssetCandidateLike[] = [
    candidate(WETH, "WETH", true, true),
    candidate(NVDA, "NVDA", true),
    candidate(SGOV, "SGOV", true),
    candidate(SPY, "SPY", true),
  ];

  it("resolves the AI preset to WETH + NVDA when both are live-green", () => {
    const ai = PRESETS.find((p) => p.key === "ai")!;
    expect(resolvePreset(ai, allGreen, 2)).toEqual([WETH, NVDA]);
  });

  it("resolves the ETH-only preset to just WETH", () => {
    const eth = PRESETS.find((p) => p.key === "eth")!;
    expect(resolvePreset(eth, allGreen, 2)).toEqual([WETH]);
  });

  it("drops a preset when one of its assets is not green", () => {
    const candidates: QuoteAssetCandidateLike[] = [
      candidate(WETH, "WETH", true, true),
      candidate(NVDA, "NVDA", false), // not yet accepted by the factory
    ];
    const ai = PRESETS.find((p) => p.key === "ai")!;
    expect(resolvePreset(ai, candidates, 2)).toBeNull();
  });

  it("drops a preset when the referenced asset isn't in the registry at all", () => {
    const candidates: QuoteAssetCandidateLike[] = [candidate(WETH, "WETH", true, true)];
    const cashLike = PRESETS.find((p) => p.key === "cash")!;
    expect(resolvePreset(cashLike, candidates, 2)).toBeNull();
    const spyIndex = PRESETS.find((p) => p.key === "index")!;
    expect(resolvePreset(spyIndex, candidates, 2)).toBeNull();
  });

  it("never marks an unresolved (non-true) isGreen read as selectable", () => {
    // isGreen computed upstream already folds "unresolved/failed" into false —
    // resolvePreset must still refuse a false, not just a missing candidate.
    const candidates: QuoteAssetCandidateLike[] = [
      candidate(WETH, "WETH", true, true),
      candidate(SGOV, "SGOV", false),
    ];
    const cashLike = PRESETS.find((p) => p.key === "cash")!;
    expect(resolvePreset(cashLike, candidates, 2)).toBeNull();
  });

  it("drops a preset that would exceed the live MAX_QUOTE_ASSETS cap", () => {
    const ai = PRESETS.find((p) => p.key === "ai")!;
    expect(resolvePreset(ai, allGreen, 1)).toBeNull();
    // the single-asset ETH-only preset still fits under a cap of 1
    const eth = PRESETS.find((p) => p.key === "eth")!;
    expect(resolvePreset(eth, allGreen, 1)).toEqual([WETH]);
  });

  it("every preset description avoids banned copy", () => {
    const banned = /floor|guarantee|protect|secure|safe|yield|insur|return|passive income|dividend|APR|mcap/i;
    for (const preset of PRESETS) {
      expect(preset.description).not.toMatch(banned);
    }
  });
});

describe("availablePresets", () => {
  it("returns only live-accepted presets, in PRESETS order", () => {
    const candidates: QuoteAssetCandidateLike[] = [
      candidate(WETH, "WETH", true, true),
      candidate(NVDA, "NVDA", true),
      // SGOV and SPY absent -> cash and index presets drop
    ];
    const result = availablePresets(candidates, 2);
    expect(result.map((r) => r.preset.key)).toEqual(["ai", "eth"]);
  });

  it("returns an empty list when even WETH isn't available", () => {
    expect(availablePresets([], 2)).toEqual([]);
  });
});
