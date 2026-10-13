import { describe, it, expect } from "vitest";
import { sequencerNote, hasPricedAssets, displayedTotalUsd } from "./backing";

describe("sequencerNote", () => {
  it("Unknown (0) -> unverifiable — no sequencer feed on Robinhood Chain", () => {
    expect(sequencerNote(0)).toBe("unverifiable");
  });
  it("Up (1) -> none", () => {
    expect(sequencerNote(1)).toBe("none");
  });
  it("GracePeriod (2) and Down (3) -> untrusted", () => {
    expect(sequencerNote(2)).toBe("untrusted");
    expect(sequencerNote(3)).toBe("untrusted");
  });
});

describe("pricing is independent of the sequencer status (mocked balance)", () => {
  // Mirrors BCAT's real on-chain treasury (NVDA priced=true, verified live),
  // but with a NON-ZERO balance so the USD value is non-zero — proving a
  // treasury holding a priced asset shows a real value even when the sequencer
  // status is Unknown (no feed on this chain). On-chain today every treasury
  // reads $0 only because none holds a non-zero balance yet.
  const backing = {
    sequencerStatus: 0, // Unknown
    totalValueUsd: 22553n * 10n ** 13n, // ~$225.53 scaled to 1e18
    assets: [{ priced: true, stale: false }],
  };

  it("keeps the asset priced and the value non-zero with Unknown sequencer", () => {
    expect(hasPricedAssets(backing.assets)).toBe(true);
    expect(displayedTotalUsd(backing)).toBeGreaterThan(0n);
    expect(sequencerNote(backing.sequencerStatus)).toBe("unverifiable");
  });

  it("reports no priced assets only when the feed genuinely didn't price any", () => {
    expect(hasPricedAssets([{ priced: false }])).toBe(false);
    expect(hasPricedAssets([])).toBe(false);
  });
});
