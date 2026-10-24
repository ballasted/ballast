import { describe, it, expect } from "vitest";
import { parseUnits } from "viem";
import { formatSmallUsd, formatBackingPerToken, formatUsd, formatTokenAmount, formatTokenExact } from "./format";

describe("formatTokenAmount — overflow-proof token quantities", () => {
  it("abbreviates the reported overflow balance instead of dumping raw digits", () => {
    // The exact string from the bug report: 103414705.864583232899041590 JPUMP.
    const raw = parseUnits("103414705.864583232899041590", 18);
    const s = formatTokenAmount(raw);
    expect(s).toBe("103.41M");
    expect(s.length).toBeLessThanOrEqual(8); // never the 27-char raw string
  });

  it("abbreviates billions and trillions with B/T", () => {
    expect(formatTokenAmount(parseUnits("2500000000", 18))).toBe("2.5B");
    expect(formatTokenAmount(parseUnits("1200000000000", 18))).toBe("1.2T");
  });

  it("groups mid-range values with commas, ≤2 decimals", () => {
    expect(formatTokenAmount(parseUnits("1234.5678", 18))).toBe("1,234.57");
    expect(formatTokenAmount(parseUnits("103414", 18))).toBe("103,414");
  });

  it("keeps up to 4 significant digits below 1", () => {
    expect(formatTokenAmount(0.000123)).toBe("0.000123");
    expect(formatTokenAmount(0.5)).toBe("0.5");
  });

  it("floors anything below 0.0001 to <0.0001, never a misleading 0", () => {
    expect(formatTokenAmount(5e-7)).toBe("<0.0001");
    expect(formatTokenAmount(parseUnits("0.00001", 18))).toBe("<0.0001");
  });

  it("renders a genuine zero as 0", () => {
    expect(formatTokenAmount(0n)).toBe("0");
    expect(formatTokenAmount(0)).toBe("0");
  });

  it("honours non-18 decimals", () => {
    expect(formatTokenAmount(1234567890n, { decimals: 6 })).toBe("1,234.57");
  });

  it("preserves sign for negative amounts (swap deltas)", () => {
    expect(formatTokenAmount(parseUnits("-2500000", 18))).toBe("-2.5M");
  });
});

describe("formatTokenExact — tap/hover reveal", () => {
  it("shows the full value, comma-grouped, nothing truncated", () => {
    const raw = parseUnits("103414705.864583232899041590", 18);
    expect(formatTokenExact(raw)).toBe("103,414,705.86458323289904159");
  });
  it("handles sub-1 and whole values", () => {
    expect(formatTokenExact(parseUnits("0.00001", 18))).toBe("0.00001");
    expect(formatTokenExact(parseUnits("1000", 18))).toBe("1,000");
  });
});

describe("formatSmallUsd — never renders a real value as zero", () => {
  it("a 5e-7 value renders in scientific notation, not $0.00", () => {
    const s = formatSmallUsd(5e-7);
    expect(s).not.toBe("$0.00");
    expect(s.toLowerCase()).toContain("e-7");
  });

  it("genuine zero still renders as $0.00", () => {
    expect(formatSmallUsd(0)).toBe("$0.00");
  });

  it("mid-range values use fixed notation", () => {
    expect(formatSmallUsd(0.005)).toBe("$0.00500");
    expect(formatSmallUsd(1.5)).toBe("$1.5");
  });
});

describe("formatBackingPerToken — routes through the same small-dollar formatter as price", () => {
  it("a 5e-7-magnitude backing figure (e.g. BCAT: 1e9 supply, thin backing) never renders $0.000000", () => {
    const value1e18 = 500_000_000_000n; // 5e-7 * 1e18
    const s = formatBackingPerToken(value1e18);
    expect(s).not.toBe("$0.000000");
    expect(s).not.toBe("$0.00");
    expect(s.toLowerCase()).toContain("e-7");
  });

  it("zero backing still renders as $0.00", () => {
    expect(formatBackingPerToken(0n)).toBe("$0.00");
  });
});

describe("formatUsd", () => {
  it("formats a whole-dollar 1e18 value", () => {
    expect(formatUsd(219_670_000_000_000_000_000n)).toBe("$219.67");
  });
});
