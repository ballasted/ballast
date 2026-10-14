import { describe, it, expect } from "vitest";
import { routeRevertReason, needsBuybackWire } from "./feeRouter";

describe("routeRevertReason", () => {
  it("NothingToRoute → explains no fees yet (the smoke-test case)", () => {
    expect(routeRevertReason("NothingToRoute", 1000, 0)).toMatch(/no fees to route yet/i);
  });
  it("Cooldown → countdown when readyAt is in the future", () => {
    const msg = routeRevertReason("Cooldown", 1000, 1120);
    expect(msg).toMatch(/cooldown/i);
    expect(msg).toMatch(/ready in/i);
  });
  it("Cooldown → no countdown once readyAt has passed", () => {
    expect(routeRevertReason("Cooldown", 1000, 900)).toBe("On cooldown.");
  });
  it("MinAmountOutNotMet → slippage hint", () => {
    expect(routeRevertReason("MinAmountOutNotMet", 1000, 0)).toMatch(/price too far|slippage|try again/i);
  });
  it("unknown / undefined → generic, never a false 'Ready'", () => {
    expect(routeRevertReason(undefined, 1000, 0)).toMatch(/can't route/i);
    expect(routeRevertReason("Weird", 1000, 0)).toMatch(/Weird/);
  });
});

describe("needsBuybackWire", () => {
  it("true when buyback is active but the pool isn't wired", () => {
    expect(needsBuybackWire({ buybackWired: false, buybackBps: 2500, hasPendingSplit: false, pendingBuybackBps: 0 })).toBe(true);
  });
  it("true when a SCHEDULED split will route to buyback (the smoke-test case)", () => {
    expect(needsBuybackWire({ buybackWired: false, buybackBps: 0, hasPendingSplit: true, pendingBuybackBps: 3500 })).toBe(true);
  });
  it("false once the pool is wired", () => {
    expect(needsBuybackWire({ buybackWired: true, buybackBps: 2500, hasPendingSplit: true, pendingBuybackBps: 3500 })).toBe(false);
  });
  it("false when no buyback bucket is used", () => {
    expect(needsBuybackWire({ buybackWired: false, buybackBps: 0, hasPendingSplit: false, pendingBuybackBps: 0 })).toBe(false);
  });
});
