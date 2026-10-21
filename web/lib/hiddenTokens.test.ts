import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  isHiddenToken,
  HIDDEN_TOKEN_ADDRESSES,
  CODE_HIDDEN_TOKENS,
  parseHiddenList,
  HIDDEN_TOKEN_NOTICE,
} from "./hiddenTokens";

// Known smoke/test tokens that must never surface on a browsable list.
const TEST = "0x3Fec2b548755d53fD8DB97CAc0C14DFA99F0e335"; // gen-4 "TEST" probe (mixed case on purpose)
const SMOKE_V2 = "0x28C53790D77A23715972aE01ab7fa8430B31846f"; // FeeRouter v2 smoke launch
const LIVE = "0xDc605041F02e41CbD8FDC347023e93C4c3fA243C"; // $BALLAST v2 — a real, live token

describe("isHiddenToken", () => {
  it("hides the gen-4 TEST probe (case-insensitive)", () => {
    expect(isHiddenToken(TEST as Address)).toBe(true);
    expect(isHiddenToken(TEST.toLowerCase() as Address)).toBe(true);
  });

  it("hides the FeeRouter v2 smoke launch", () => {
    expect(isHiddenToken(SMOKE_V2 as Address)).toBe(true);
  });

  it("does NOT hide a live token", () => {
    expect(isHiddenToken(LIVE as Address)).toBe(false);
  });

  it("returns false for undefined / null / empty", () => {
    expect(isHiddenToken(undefined)).toBe(false);
    expect(isHiddenToken(null)).toBe(false);
    expect(isHiddenToken("")).toBe(false);
  });
});

describe("CODE_HIDDEN_TOKENS", () => {
  it("are all lowercased canonical addresses", () => {
    for (const a of CODE_HIDDEN_TOKENS) {
      expect(a).toBe(a.toLowerCase());
      expect(/^0x[0-9a-f]{40}$/.test(a)).toBe(true);
    }
  });
  it("are included in the effective list", () => {
    for (const a of CODE_HIDDEN_TOKENS) expect(HIDDEN_TOKEN_ADDRESSES).toContain(a);
  });
});

describe("parseHiddenList", () => {
  it("splits on commas and whitespace, lowercases, drops junk", () => {
    const out = parseHiddenList(`${TEST}, ${SMOKE_V2}\n notanaddress 0x123`);
    expect(out).toEqual([TEST.toLowerCase(), SMOKE_V2.toLowerCase()]);
  });
  it("handles empty / undefined", () => {
    expect(parseHiddenList(undefined)).toEqual([]);
    expect(parseHiddenList("")).toEqual([]);
  });
});

describe("HIDDEN_TOKEN_NOTICE copy", () => {
  it("is neutral — no ticker, no investment or claim language", () => {
    expect(HIDDEN_TOKEN_NOTICE).toMatch(/hidden/i);
    expect(HIDDEN_TOKEN_NOTICE).not.toMatch(/floor|safe|guaranteed|yield|reward|return/i);
  });
});

// The Discover grid and the Create page Parent picker share one predicate:
// exclude hidden tokens from any browsable list. These tests pin the behaviour
// the two surfaces rely on, so a regression there fails here.
describe("browsable-list filtering (Discover + Parent picker)", () => {
  type P = { token: Address; hasPool: boolean };
  const projects: P[] = [
    { token: TEST as Address, hasPool: true },
    { token: SMOKE_V2 as Address, hasPool: true },
    { token: LIVE as Address, hasPool: true },
  ];

  it("Discover excludes every hidden token", () => {
    const visible = projects.filter((p) => !isHiddenToken(p.token));
    expect(visible.map((p) => p.token)).toEqual([LIVE]);
    expect(visible.some((p) => isHiddenToken(p.token))).toBe(false);
  });

  it("Parent picker (pool + not hidden) never offers a hidden token", () => {
    const parentOptions = projects.filter((p) => p.hasPool && !isHiddenToken(p.token));
    expect(parentOptions.map((p) => p.token)).toEqual([LIVE]);
    expect(parentOptions.find((p) => isHiddenToken(p.token))).toBeUndefined();
  });
});
