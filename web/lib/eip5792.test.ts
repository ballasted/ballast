import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { atomicStatusFor, supportsAtomicBatch, buildBasketCalls, stepSignatureCount, type BatchLeg } from "./eip5792";

const CHAIN = 4663;
const ASSET_A = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address; // NVDA
const ASSET_B = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" as Address; // SPY
const ZAP = "0x000000000000000000000000000000000000aaaa" as Address;
const TOKEN = "0x000000000000000000000000000000000000bbbb" as Address;
const TREASURY = "0x000000000000000000000000000000000000cccc" as Address;

describe("atomicStatusFor", () => {
  it("reads the current-spec atomic.status", () => {
    expect(atomicStatusFor({ [CHAIN]: { atomic: { status: "supported" } } }, CHAIN)).toBe("supported");
    expect(atomicStatusFor({ [CHAIN]: { atomic: { status: "ready" } } }, CHAIN)).toBe("ready");
    expect(atomicStatusFor({ [CHAIN]: { atomic: { status: "unsupported" } } }, CHAIN)).toBe("unsupported");
  });

  it("reads the older atomicBatch.supported shape", () => {
    expect(atomicStatusFor({ [CHAIN]: { atomicBatch: { supported: true } } }, CHAIN)).toBe("supported");
    expect(atomicStatusFor({ [CHAIN]: { atomicBatch: { supported: false } } }, CHAIN)).toBe("unsupported");
  });

  it("returns unknown when the chain or capability is absent", () => {
    expect(atomicStatusFor(undefined, CHAIN)).toBe("unknown");
    expect(atomicStatusFor({ [CHAIN]: {} }, CHAIN)).toBe("unknown");
    expect(atomicStatusFor({ 1: { atomic: { status: "supported" } } }, CHAIN)).toBe("unknown");
  });
});

describe("supportsAtomicBatch", () => {
  it("is true only for supported/ready", () => {
    expect(supportsAtomicBatch({ [CHAIN]: { atomic: { status: "supported" } } }, CHAIN)).toBe(true);
    expect(supportsAtomicBatch({ [CHAIN]: { atomic: { status: "ready" } } }, CHAIN)).toBe(true);
    expect(supportsAtomicBatch({ [CHAIN]: { atomic: { status: "unsupported" } } }, CHAIN)).toBe(false);
    expect(supportsAtomicBatch(undefined, CHAIN)).toBe(false);
  });
});

describe("buildBasketCalls", () => {
  const legs: BatchLeg[] = [
    { asset: ASSET_A, weightBps: 6000, preferFables: false, fablesHopIdx: [0n, 1n], ramsesHopIdx: [0n], minOut: 100n },
    { asset: ASSET_B, weightBps: 4000, preferFables: false, fablesHopIdx: [0n, 10n], ramsesHopIdx: [1n], minOut: 50n },
  ];
  const calls = buildBasketCalls({ basketZap: ZAP, launchToken: TOKEN, treasury: TREASURY, ethIn: 10n ** 18n, legs, deadline: 999n });

  it("emits swap + (approve, deposit) per leg in order", () => {
    // 1 swap + 2 legs * 2 = 5 calls
    expect(calls).toHaveLength(5);
    expect(calls[0]!.to).toBe(ZAP);
    expect(calls[0]!.value).toBe(10n ** 18n); // ETH goes on the swap call
    // leg A: approve on the asset, deposit on the treasury
    expect(calls[1]!.to).toBe(ASSET_A);
    expect(calls[2]!.to).toBe(TREASURY);
    // leg B
    expect(calls[3]!.to).toBe(ASSET_B);
    expect(calls[4]!.to).toBe(TREASURY);
  });

  it("only the swap call carries ETH value", () => {
    expect(calls.slice(1).every((c) => c.value === undefined)).toBe(true);
  });

  it("encodes non-empty calldata for every call", () => {
    expect(calls.every((c) => c.data.startsWith("0x") && c.data.length > 2)).toBe(true);
  });
});

describe("stepSignatureCount", () => {
  const legs = [{ minOut: 100n }, { minOut: 50n }];

  it("counts swap + deposit + approve when no allowance exists", () => {
    // 1 swap + (approve+deposit)*2 = 5
    expect(stepSignatureCount(legs, [0n, 0n])).toBe(5);
  });

  it("skips the approve when allowance already covers minOut", () => {
    // both pre-approved: 1 swap + 2 deposits = 3
    expect(stepSignatureCount(legs, [100n, 50n])).toBe(3);
    // one pre-approved: 1 swap + 2 deposits + 1 approve = 4
    expect(stepSignatureCount(legs, [100n, 0n])).toBe(4);
  });

  it("treats a missing allowance entry as zero (needs approve)", () => {
    expect(stepSignatureCount(legs, [])).toBe(5);
  });
});
