import { describe, it, expect } from "vitest";
import { formatSmallUsd, formatBackingPerToken, formatUsd } from "./format";

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
