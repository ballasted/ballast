import { describe, it, expect } from "vitest";
import { factsToPrompt, type SummaryFacts } from "./summaryData";
import { hasBannedContent } from "./guardrails";

const TOKEN = "0x1111111111111111111111111111111111111111" as const;

describe("factsToPrompt", () => {
  it("assembles a backed token's facts with the no-claim reminder", () => {
    const facts: SummaryFacts = {
      found: true,
      token: TOKEN,
      symbol: "HRBR",
      name: "Harbor Reserve",
      ballasted: true,
      totalValueUsd: 125_000,
      backingPerTokenUsd: 0.000125,
      anyStale: false,
      noticePeriodDays: 30,
      feeSplit: { version: 2, creatorBps: 6000, treasuryBps: 2000, buybackBps: 1000, rewardsBps: 1000, parentBurnBps: 0 },
    };
    const p = factsToPrompt(facts);
    expect(p).toContain("Harbor Reserve");
    expect(p).toContain("Treasury backing: YES");
    expect(p).toContain("125,000");
    expect(p).toContain("30 days");
    expect(p).toContain("creator 60%");
    expect(p).toContain("treasury 20%");
    expect(p).toMatch(/no claim, redemption right, or entitlement/i);
    // The assembled PROMPT itself must not carry banned copy into the model.
    expect(hasBannedContent(p)).toBe(false);
  });

  it("states plainly when there is no backing", () => {
    const facts: SummaryFacts = {
      found: true,
      token: TOKEN,
      symbol: "ZORB",
      name: "Zorblin",
      ballasted: false,
      noticePeriodDays: 7,
    };
    const p = factsToPrompt(facts);
    expect(p).toContain("Treasury backing: NONE");
    expect(p).toContain("7 days");
  });

  it("notes a missing fee router", () => {
    const facts: SummaryFacts = { found: true, token: TOKEN, symbol: "ZORB", ballasted: false };
    expect(factsToPrompt(facts)).toContain("no fee router configured");
  });

  it("flags a resting/stale feed when present", () => {
    const facts: SummaryFacts = {
      found: true,
      token: TOKEN,
      symbol: "HRBR",
      name: "Harbor",
      ballasted: true,
      totalValueUsd: 1000,
      backingPerTokenUsd: 0.001,
      anyStale: true,
    };
    expect(factsToPrompt(facts)).toMatch(/resting\/stale/i);
  });
});
