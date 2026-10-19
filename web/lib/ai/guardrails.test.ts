import { describe, it, expect } from "vitest";
import {
  findBannedWords,
  hasBannedContent,
  isBlockedTicker,
  isBlockedName,
  filterSuggestion,
  isSummaryClean,
} from "./guardrails";

describe("banned-word filter", () => {
  it("catches CLAUDE.md rule-1 words on word boundaries", () => {
    expect(findBannedWords("your funds stay safe here")).toContain("safe");
    expect(findBannedWords("a guaranteed floor on the token")).toEqual(
      expect.arrayContaining(["guaranteed", "floor"]),
    );
    expect(findBannedWords("earn yield and dividends")).toEqual(
      expect.arrayContaining(["yield", "dividends"]),
    );
    expect(findBannedWords("5% APR, risk-free passive income")).toEqual(
      expect.arrayContaining(["apr", "risk-free", "passive income"]),
    );
  });

  it("does not false-positive on unrelated substrings", () => {
    // "safeguard" / "returning" should NOT trip "safe" / "returns" — word boundaries.
    expect(hasBannedContent("a transparent, auditable launchpad")).toBe(false);
    expect(hasBannedContent("an index of technology companies")).toBe(false);
  });

  it("catches obvious price-prediction hype", () => {
    expect(hasBannedContent("this will reach the moon soon")).toBe(true);
    expect(hasBannedContent("a clean 100x opportunity")).toBe(true);
    expect(hasBannedContent("the next Bitcoin")).toBe(true);
  });
});

describe("brand / ticker blocklist", () => {
  it("blocks our listed stock tickers and crypto majors", () => {
    for (const t of ["NVDA", "SPY", "AAPL", "TSLA", "BTC", "ETH", "USDC"]) {
      expect(isBlockedTicker(t)).toBe(true);
    }
    expect(isBlockedTicker("nvda")).toBe(true); // case-insensitive
  });

  it("allows an unrelated ticker", () => {
    expect(isBlockedTicker("MANA")).toBe(false);
    expect(isBlockedTicker("ZORB")).toBe(false);
  });

  it("blocks names that impersonate real brands", () => {
    expect(isBlockedName("Apple Treasury")).toBe(true);
    expect(isBlockedName("tesla index")).toBe(true);
    expect(isBlockedName("Bitcoin Reserve")).toBe(true);
    expect(isBlockedName("S&P Mirror")).toBe(true);
  });

  it("allows an original name", () => {
    expect(isBlockedName("Harbor Reserve")).toBe(false);
    expect(isBlockedName("Zorblin Index")).toBe(false);
  });
});

describe("filterSuggestion", () => {
  const good = {
    names: ["Harbor Reserve", "Anchor Index", "Keel Fund"],
    tickers: ["HRBR", "ANCH", "KEEL"],
    description: "A transparent index of tokenized assets with an on-chain treasury.",
    pairingSuggestion: "Pair with WETH for the deepest route.",
    treasuryPreset: "Back with SGOV, 30-day notice.",
    noticeDays: 30,
    feeSplitSuggestion: "creator 60, treasury 20, buyback 10, stakers 10",
    feeSplitBps: { creatorBps: 6000, treasuryBps: 2000, buybackBps: 1000, rewardsBps: 1000 },
    reasoning: "Fits a treasury-backed index.",
  };

  it("accepts a clean suggestion and keeps structured hints", () => {
    const r = filterSuggestion(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.names.length).toBe(3);
      expect(r.value.tickers).toEqual(["HRBR", "ANCH", "KEEL"]);
      expect(r.value.noticeDays).toBe(30);
      expect(r.value.feeSplitBps).toEqual({ creatorBps: 6000, treasuryBps: 2000, buybackBps: 1000, rewardsBps: 1000 });
    }
  });

  it("rejects the batch when a free-text field has banned copy", () => {
    const r = filterSuggestion({ ...good, description: "Your deposit is guaranteed and safe." });
    expect(r.ok).toBe(false);
  });

  it("drops blocked names/tickers but keeps clean ones", () => {
    const r = filterSuggestion({
      ...good,
      names: ["Apple Fund", "Harbor Reserve", "Tesla Index"],
      tickers: ["NVDA", "HRBR", "SPY"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.names).toEqual(["Harbor Reserve"]);
      expect(r.value.tickers).toEqual(["HRBR"]);
    }
  });

  it("rejects when every name or ticker is blocked", () => {
    expect(filterSuggestion({ ...good, names: ["Apple", "Tesla", "Nvidia"] }).ok).toBe(false);
    expect(filterSuggestion({ ...good, tickers: ["NVDA", "SPY", "BTC"] }).ok).toBe(false);
  });

  it("drops a feeSplitBps that does not sum to 10000", () => {
    const r = filterSuggestion({ ...good, feeSplitBps: { creatorBps: 5000, treasuryBps: 2000, buybackBps: 1000, rewardsBps: 1000 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.feeSplitBps).toBeUndefined();
  });

  it("drops a noticeDays that is not 7/30/90", () => {
    const r = filterSuggestion({ ...good, noticeDays: 45 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.noticeDays).toBeUndefined();
  });

  it("rejects non-objects and empty inputs", () => {
    expect(filterSuggestion(null).ok).toBe(false);
    expect(filterSuggestion("nope").ok).toBe(false);
    expect(filterSuggestion({ names: [], tickers: [], description: "" }).ok).toBe(false);
  });

  it("strips $ prefixes and uppercases tickers", () => {
    const r = filterSuggestion({ ...good, tickers: ["$hrbr", "anch", "keel"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tickers).toEqual(["HRBR", "ANCH", "KEEL"]);
  });
});

describe("isSummaryClean", () => {
  it("passes a compliant summary", () => {
    expect(
      isSummaryClean(
        "This token holds an on-chain treasury. Holding it gives no claim on the assets. The creator can withdraw after a 30-day notice.",
      ),
    ).toBe(true);
  });
  it("fails a summary that promises safety or yield", () => {
    expect(isSummaryClean("A safe way to earn yield on your deposit.")).toBe(false);
  });
});
