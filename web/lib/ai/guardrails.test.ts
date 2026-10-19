import { describe, it, expect } from "vitest";
import {
  findBannedWords,
  hasBannedContent,
  isBlockedTicker,
  isBlockedName,
  isFundLikeName,
  sanitizePairing,
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

  it("catches investment-product framing (the exact bad screenshot output)", () => {
    const bad =
      "This token represents a diversified collection of tokenized real-world assets and provides exposure to a variety of asset classes.";
    const hits = findBannedWords(bad);
    expect(hits).toEqual(expect.arrayContaining(["represents", "diversified", "exposure"]));
    expect(hits.some((h) => /asset class/.test(h))).toBe(true);
    expect(hasBannedContent(bad)).toBe(true);
  });

  it("catches invest / ETF / index fund / portfolio / tracks / backed by real", () => {
    expect(hasBannedContent("invest now")).toBe(true);
    expect(hasBannedContent("investment opportunity")).toBe(true);
    expect(hasBannedContent("a tokenized ETF")).toBe(true);
    expect(hasBannedContent("basically an index fund")).toBe(true);
    expect(hasBannedContent("manage your portfolio")).toBe(true);
    expect(hasBannedContent("it tracks the S&P")).toBe(true);
    expect(hasBannedContent("fully backed by real estate")).toBe(true);
    expect(hasBannedContent("gives you exposure to tech")).toBe(true);
  });

  it("does not false-positive on unrelated substrings", () => {
    expect(hasBannedContent("a playful community token for dog lovers")).toBe(false);
    expect(hasBannedContent("the vibe is cozy and fun")).toBe(false);
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
    expect(isBlockedTicker("nvda")).toBe(true);
  });

  it("blocks fund-like tickers", () => {
    for (const t of ["ETF", "FUND", "TRUST", "BANK", "BOND", "CAPITAL"]) {
      expect(isBlockedTicker(t)).toBe(true);
    }
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

  it("blocks fund-like names, and 'Index' unless the user asked for it", () => {
    for (const n of ["Clean Energy ETF", "Growth Fund", "Harbor Trust", "Apex Capital", "Doge Holdings", "Meme Bank"]) {
      expect(isFundLikeName(n, false)).toBe(true);
    }
    expect(isFundLikeName("Solar Index", false)).toBe(true); // index not allowed
    expect(isFundLikeName("Solar Index", true)).toBe(false); // user typed "index"
    expect(isFundLikeName("Harbor Vibes", false)).toBe(false);
  });
});

describe("sanitizePairing", () => {
  it("keeps ETH / listed stock pairings", () => {
    expect(sanitizePairing("Pair with ETH for the deepest liquidity.")).toMatch(/ETH/);
    expect(sanitizePairing("Pair with SGOV, a tokenized T-bill token.")).toMatch(/SGOV/);
    expect(sanitizePairing("NVDA makes a fun thematic pair.")).toMatch(/NVDA/);
  });

  it("drops USDC/USDT/stablecoin and generic-crypto pairings", () => {
    expect(sanitizePairing("Pair with USDC for stability and ease of trading.")).toBeUndefined();
    expect(sanitizePairing("Use USDT, a widely used cryptocurrency.")).toBeUndefined();
    expect(sanitizePairing("Pair with a popular stablecoin.")).toBeUndefined();
    expect(sanitizePairing("Pair with Bitcoin for exposure.")).toBeUndefined();
  });

  it("drops a pairing that names no real option", () => {
    expect(sanitizePairing("Pick whatever quote asset you like.")).toBeUndefined();
    expect(sanitizePairing(undefined)).toBeUndefined();
  });
});

describe("filterSuggestion", () => {
  const good = {
    names: ["Harbor Vibes", "Anchor Crew", "Keel Club"],
    tickers: ["HRBR", "ANCH", "KEEL"],
    description: "A playful community token for people who love the sea. Join the crew and ride the tide.",
    pairingSuggestion: "Pair with ETH for the deepest liquidity.",
    treasuryPreset: "The creator's treasury holds SGOV, with a 30-day notice.",
    noticeDays: 30,
    feeSplitSuggestion: "creator 60, treasury 20, buyback 10, stakers 10",
    feeSplitBps: { creatorBps: 6000, treasuryBps: 2000, buybackBps: 1000, rewardsBps: 1000 },
    reasoning: "Fits a nautical community vibe.",
  };

  it("accepts a clean community suggestion and keeps structured hints", () => {
    const r = filterSuggestion(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.names.length).toBe(3);
      expect(r.value.tickers).toEqual(["HRBR", "ANCH", "KEEL"]);
      expect(r.value.noticeDays).toBe(30);
      expect(r.value.pairingSuggestion).toMatch(/ETH/);
      expect(r.value.feeSplitBps).toEqual({ creatorBps: 6000, treasuryBps: 2000, buybackBps: 1000, rewardsBps: 1000 });
    }
  });

  it("regenerates (rejects) on the exact bad investment-framing description", () => {
    const r = filterSuggestion({
      ...good,
      description:
        "Represents a diversified collection of tokenized real-world assets and provides exposure to a variety of asset classes.",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects the batch when a free-text field has banned copy", () => {
    expect(filterSuggestion({ ...good, description: "Your deposit is guaranteed and safe." }).ok).toBe(false);
    expect(filterSuggestion({ ...good, reasoning: "A great way to invest." }).ok).toBe(false);
  });

  it("drops fund-like + brand names/tickers but keeps clean ones", () => {
    const r = filterSuggestion({
      ...good,
      names: ["Growth Fund", "Harbor Vibes", "Apple ETF"],
      tickers: ["NVDA", "HRBR", "FUND"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.names).toEqual(["Harbor Vibes"]);
      expect(r.value.tickers).toEqual(["HRBR"]);
    }
  });

  it("allows an 'Index' name only when the user typed index", () => {
    const withIndex = { ...good, names: ["Solar Index", "Solar Crew", "Solar Vibes"] };
    const blocked = filterSuggestion(withIndex);
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.value.names).toEqual(["Solar Crew", "Solar Vibes"]);

    const allowed = filterSuggestion(withIndex, { userText: "make me a solar index token" });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.value.names).toContain("Solar Index");
  });

  it("drops a USDC pairing instead of showing it", () => {
    const r = filterSuggestion({ ...good, pairingSuggestion: "Pair with USDC for stability." });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pairingSuggestion).toBeUndefined();
  });

  it("rejects when every name or ticker is blocked", () => {
    expect(filterSuggestion({ ...good, names: ["Apple", "Tesla ETF", "Growth Fund"] }).ok).toBe(false);
    expect(filterSuggestion({ ...good, tickers: ["NVDA", "SPY", "ETF"] }).ok).toBe(false);
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
        "This is a community token on BALLAST. The creator's treasury holds backing, and holding the token gives no claim on it. The creator can withdraw after a 30-day notice.",
      ),
    ).toBe(true);
  });
  it("fails a summary that frames the token as an investment", () => {
    expect(isSummaryClean("A safe way to earn yield on your deposit.")).toBe(false);
    expect(isSummaryClean("This token gives you exposure to a diversified portfolio.")).toBe(false);
  });
});
