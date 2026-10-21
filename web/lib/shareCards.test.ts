import { describe, it, expect } from "vitest";
import { buildEventCardUrl, buildXIntentUrl, buildShareText, normTicker, cardDefaults, type ShareEventType } from "./shareCards";

const TOKEN = "0x28C53790D77A23715972aE01ab7fa8430B31846f";
const TYPES: ShareEventType[] = ["launch", "buyback", "burn", "backing", "split", "basket", "vote-winner"];
const BANNED = /\b(floor|guaranteed|protected|safe|yield|APR|cashback|dividend|passive income|reward)\b/i;

describe("normTicker", () => {
  it("adds a leading $ once", () => {
    expect(normTicker("NVDA")).toBe("$NVDA");
    expect(normTicker("$NVDA")).toBe("$NVDA");
    expect(normTicker(undefined)).toBeUndefined();
  });
});

describe("buildEventCardUrl", () => {
  it("encodes type + fields and points at /api/og/event", () => {
    const u = buildEventCardUrl({ type: "buyback", value: "116,669 $BALLAST", valueLabel: "sent to the dead address", token: TOKEN as `0x${string}` });
    expect(u).toContain("/api/og/event?");
    expect(u).toContain("type=buyback");
    // URLSearchParams form-encodes spaces as "+"; decode with that in mind.
    const decoded = decodeURIComponent(u).replace(/\+/g, " ");
    expect(decoded).toContain("value=116,669 $BALLAST");
    expect(decoded).toContain("sent to the dead address");
  });
});

describe("buildShareText / buildXIntentUrl copy rules", () => {
  it("no share text contains a banned term, for any type", () => {
    for (const type of TYPES) {
      const text = buildShareText({ type, ticker: "NVDA", value: "1,000" });
      expect(text, `${type}: ${text}`).not.toMatch(BANNED);
    }
  });
  it("burn cards say 'sent to the dead address'", () => {
    expect(buildShareText({ type: "buyback", value: "9 $BALLAST" })).toContain("sent to the dead address");
    expect(buildShareText({ type: "burn", value: "9 $BALLAST" })).toContain("sent to the dead address");
  });
  it("no share text mentions price or market cap", () => {
    for (const type of TYPES) expect(buildShareText({ type, ticker: "X", value: "1" })).not.toMatch(/price|market ?cap|\$\d|USD/i);
  });
  it("X intent includes prefilled text and a link", () => {
    const u = buildXIntentUrl({ type: "launch", ticker: "NVDA", token: TOKEN as `0x${string}` });
    expect(u).toContain("twitter.com/intent/tweet");
    expect(u).toContain("text=");
    expect(decodeURIComponent(u)).toContain(`/app/token/${TOKEN}`);
  });
});

describe("cardDefaults", () => {
  it("has an emoji + headline for every type", () => {
    for (const type of TYPES) {
      const d = cardDefaults(type);
      expect(d.emoji).toBeTruthy();
      expect(d.headline).toBeTruthy();
    }
  });
});
