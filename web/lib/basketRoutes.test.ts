import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { isRoutable, BASKET_PRESETS } from "./basketRoutes";

// The 7 human-verified routable assets (docs/BASKET_DISCOVERY.md §2.2) and a
// few known-dead ones, by canonical address.
const ROUTABLE: Record<string, Address> = {
  SGOV: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5",
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  GOOGL: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  SPY: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  PLTR: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
  CRCL: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5",
};
const NOT_ROUTABLE: Record<string, Address> = {
  AMD: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
  MSFT: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  META: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
};
const ROUTABLE_SYMBOLS = new Set(Object.keys(ROUTABLE));

describe("basket routable set", () => {
  it("marks exactly the 7 verified assets routable", () => {
    for (const [sym, addr] of Object.entries(ROUTABLE)) {
      expect(isRoutable(addr), `${sym} should be routable`).toBe(true);
    }
  });

  it("marks dead/thin assets not routable", () => {
    for (const [sym, addr] of Object.entries(NOT_ROUTABLE)) {
      expect(isRoutable(addr), `${sym} should NOT be routable`).toBe(false);
    }
  });

  it("is case-insensitive on the address", () => {
    const nvda = ROUTABLE.NVDA!;
    expect(isRoutable(nvda.toLowerCase() as Address)).toBe(true);
    expect(isRoutable(nvda as Address)).toBe(true);
  });
});

describe("basket presets", () => {
  it("every preset ticker is one of the 7 routable symbols", () => {
    for (const p of BASKET_PRESETS) {
      for (const t of p.tickers) {
        expect(ROUTABLE_SYMBOLS.has(t), `${p.id} preset lists non-routable ${t}`).toBe(true);
      }
    }
  });

  it("has the expected preset shape", () => {
    const byId = Object.fromEntries(BASKET_PRESETS.map((p) => [p.id, p.tickers]));
    expect(byId.index).toEqual(["SPY"]);
    expect(byId.aiChips).toEqual(["NVDA", "PLTR", "GOOGL"]);
    expect(byId.cashLike).toEqual(["SGOV"]);
    expect(byId.custom).toEqual([]);
  });
});
