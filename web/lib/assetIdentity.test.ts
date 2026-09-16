import { describe, it, expect } from "vitest";
import { resolveAssetIdentity, type RegistryAssetRef } from "./assetIdentity";

// Real addresses from docs/exit-liquidity-table.md, captured 2026-09-17 via
// GeckoTerminal against the live chain — not invented for this test. The fake
// pool exists TODAY; this fixture is what stops a UI regression from ever
// rendering it as if it were the real thing.
const REAL_GOOGL = "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3";
const FAKE_GOOGL_POOL_BASE_TOKEN = "0x1d45f0d84b83497874cb38560eb9f6d332a8372b";

const REGISTRY: RegistryAssetRef[] = [
  { address: REAL_GOOGL, symbol: "GOOGL" },
  { address: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", symbol: "SGOV" },
];

describe("resolveAssetIdentity — fake GOOGL fixture", () => {
  it("treats the real GOOGL address as recognized", () => {
    expect(resolveAssetIdentity(REAL_GOOGL, "GOOGL", REGISTRY, true)).toEqual({
      status: "recognized",
      symbol: "GOOGL",
    });
  });

  it("is case-insensitive on the address match", () => {
    expect(resolveAssetIdentity(REAL_GOOGL.toLowerCase() as `0x${string}`, "GOOGL", REGISTRY, true)).toEqual({
      status: "recognized",
      symbol: "GOOGL",
    });
  });

  it("treats the fake GOOGL/WETH pool's token — different address, same claimed ticker — as hostile, never recognized", () => {
    const result = resolveAssetIdentity(FAKE_GOOGL_POOL_BASE_TOKEN as `0x${string}`, "GOOGL", REGISTRY, true);
    expect(result.status).toBe("hostile");
    expect(result).toEqual({ status: "hostile", claimedSymbol: "GOOGL" });
  });

  it("an address not in the registry with no ticker collision is merely unrecognized, not hostile", () => {
    const result = resolveAssetIdentity("0x000000000000000000000000000000000000dEaD", "SOMERANDOMTICKER", REGISTRY, true);
    expect(result).toEqual({ status: "unrecognized" });
  });

  it("reports loading, not unrecognized, while the registry read is still in flight", () => {
    expect(resolveAssetIdentity(FAKE_GOOGL_POOL_BASE_TOKEN as `0x${string}`, "GOOGL", REGISTRY, false)).toEqual({
      status: "loading",
    });
  });

  it("an undefined address is unrecognized once loaded", () => {
    expect(resolveAssetIdentity(undefined, "GOOGL", REGISTRY, true)).toEqual({ status: "unrecognized" });
  });
});
