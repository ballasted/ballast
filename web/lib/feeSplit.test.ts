import { describe, it, expect } from "vitest";
import { feeConfigForFactory, CURRENT_FEE_CONFIG } from "@/lib/contracts";

const GEN4_FACTORY = "0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67";
const GEN1_FACTORY = "0x069974136c78Cf0F2162463B95321E59F56523D8";
const GEN2_FACTORY = "0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1";

const GEN4_FEE_CONFIG = "0xe09f093595045e8765f420cb12e0aa250910e5ad"; // 80/20/0
const GEN1_FEE_CONFIG = "0xf814ca06affabd1aa5cd31adb5f25d23e9871304"; // 50/35/15
const GEN23_FEE_CONFIG = "0xc0b895bc683bf4aca30c7277d42d068e0973a594"; // 50/35/15

// The split renders from whatever FeeConfig feeConfigForFactory resolves. These
// guard that a gen-4 launch (and the Create flow's default) can NEVER resolve to
// a 50/35/15 FeeConfig — the exact regression the review flagged.
describe("feeConfigForFactory — per-generation FeeConfig", () => {
  it("gen-4 factory → the 80/20/0 config, never a 50/35/15 one", () => {
    const cfg = feeConfigForFactory(GEN4_FACTORY as `0x${string}`).toLowerCase();
    expect(cfg).toBe(GEN4_FEE_CONFIG);
    expect(cfg).not.toBe(GEN1_FEE_CONFIG);
    expect(cfg).not.toBe(GEN23_FEE_CONFIG);
  });

  it("Create flow default (no factory) → current gen-4 config, never 50/35/15", () => {
    const cfg = feeConfigForFactory(undefined).toLowerCase();
    expect(cfg).toBe(CURRENT_FEE_CONFIG.toLowerCase());
    expect(cfg).toBe(GEN4_FEE_CONFIG);
    expect(cfg).not.toBe(GEN1_FEE_CONFIG);
    expect(cfg).not.toBe(GEN23_FEE_CONFIG);
  });

  it("gen-1 and gen-2/3 launches resolve to their own 50/35/15 config", () => {
    expect(feeConfigForFactory(GEN1_FACTORY as `0x${string}`).toLowerCase()).toBe(GEN1_FEE_CONFIG);
    expect(feeConfigForFactory(GEN2_FACTORY as `0x${string}`).toLowerCase()).toBe(GEN23_FEE_CONFIG);
  });

  it("matches the factory case-insensitively", () => {
    expect(feeConfigForFactory(GEN4_FACTORY.toLowerCase() as `0x${string}`).toLowerCase()).toBe(GEN4_FEE_CONFIG);
  });
});
