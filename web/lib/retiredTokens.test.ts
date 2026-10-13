import { describe, it, expect } from "vitest";
import { isRetiredToken, RETIRED_TOKENS, RETIRED_NOTICES } from "./contracts";

const V1 = "0x069a260370C61d91bd3e9842d81D378F9750F7F3"; // mixed-case on purpose
const V2 = "0xDc605041F02e41CbD8FDC347023e93C4c3fA243C";
const OTHER = "0x10842066A3334d76CBBc206D26C670db9768A4BF"; // $THIN

describe("RETIRED_TOKENS / isRetiredToken", () => {
  it("lists $BALLAST v1 (lowercased)", () => {
    expect(RETIRED_TOKENS).toContain("0x069a260370c61d91bd3e9842d81d378f9750f7f3");
  });

  it("matches v1 case-insensitively", () => {
    expect(isRetiredToken(V1 as `0x${string}`)).toBe(true);
    expect(isRetiredToken(V1.toLowerCase() as `0x${string}`)).toBe(true);
  });

  it("does NOT match v2 or any other live token", () => {
    expect(isRetiredToken(V2 as `0x${string}`)).toBe(false);
    expect(isRetiredToken(OTHER as `0x${string}`)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRetiredToken(undefined)).toBe(false);
  });

  it("has a notice pointing v1 at v2", () => {
    const notice = RETIRED_NOTICES["0x069a260370c61d91bd3e9842d81d378f9750f7f3"];
    expect(notice?.message).toMatch(/retired/i);
    expect(notice?.migratedTo?.toLowerCase()).toBe(V2.toLowerCase());
  });
});
