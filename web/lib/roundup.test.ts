import { describe, it, expect } from "vitest";
import { decodeAbiParameters, decodeFunctionData, type Address } from "viem";
import { encodeStockRoute, buildRoundupBuyCall, isRoundupRoutable, preferFablesFor, roundupMinOut } from "./roundup";
import { basketStockBuyerAbi } from "./abis";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
const SGOV = "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5" as Address;
const UNKNOWN = "0x000000000000000000000000000000000000dEaD" as Address;
const BUYER = "0xfD23f74950751e400bb593036492EF59EA944167" as Address;
const TRADER = "0x71048f3796C7679ce2C7af2C13B7436bdF59023d" as Address;

describe("encodeStockRoute — matches BasketStockBuyer.buyStockWithETH decode", () => {
  it("round-trips (uint256[] fablesHopIdx, uint256[] ramsesHopIdx, bool, uint256)", () => {
    const enc = encodeStockRoute({ fablesHopIdx: [0, 1], ramsesHopIdx: [0], preferFables: true, deadline: 1234n });
    const [f, r, pref, dl] = decodeAbiParameters(
      [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "bool" }, { type: "uint256" }],
      enc,
    );
    expect(f).toEqual([0n, 1n]);
    expect(r).toEqual([0n]);
    expect(pref).toBe(true);
    expect(dl).toBe(1234n);
  });
});

describe("buildRoundupBuyCall", () => {
  it("builds a BasketStockBuyer.buyStockWithETH call for a routable stock (NVDA)", () => {
    const call = buildRoundupBuyCall({
      stockBuyer: BUYER,
      stock: NVDA,
      recipient: TRADER,
      roundupEthWei: 1_000_000_000_000_000n, // 0.001 ETH
      minStockOut: 42n,
      preferFables: true,
      deadline: 9999n,
    });
    expect(call).toBeDefined();
    expect(call!.to).toBe(BUYER);
    expect(call!.value).toBe(1_000_000_000_000_000n);
    const { functionName, args } = decodeFunctionData({ abi: basketStockBuyerAbi, data: call!.data });
    expect(functionName).toBe("buyStockWithETH");
    expect(args[0]).toBe(NVDA); // stock
    expect(args[1]).toBe(TRADER); // recipient = the trader's own wallet
    expect(args[2]).toBe(42n); // minStockOut
    // route decodes to NVDA's real indices from routerV2.ts (fables [0,1], ramses [0]).
    const [f, r] = decodeAbiParameters(
      [{ type: "uint256[]" }, { type: "uint256[]" }, { type: "bool" }, { type: "uint256" }],
      args[3] as `0x${string}`,
    );
    expect(f).toEqual([0n, 1n]);
    expect(r).toEqual([0n]);
  });

  it("returns undefined for a non-routable stock (skipped, never guessed)", () => {
    expect(
      buildRoundupBuyCall({ stockBuyer: BUYER, stock: UNKNOWN, recipient: TRADER, roundupEthWei: 1n, minStockOut: 1n, preferFables: false, deadline: 1n }),
    ).toBeUndefined();
  });
});

describe("routability + venue hint", () => {
  it("NVDA is routable + prefers Fables; SGOV is routable + Ramses-only", () => {
    expect(isRoundupRoutable(NVDA)).toBe(true);
    expect(preferFablesFor(NVDA)).toBe(true);
    expect(isRoundupRoutable(SGOV)).toBe(true);
    expect(preferFablesFor(SGOV)).toBe(false); // empty fablesHopIdx
  });
  it("an unknown address is not routable", () => {
    expect(isRoundupRoutable(UNKNOWN)).toBe(false);
  });
});

describe("roundupMinOut", () => {
  it("applies slippage and floors at 1", () => {
    expect(roundupMinOut(1000n, 100)).toBe(990n); // 1% slippage
    expect(roundupMinOut(0n, 100)).toBe(1n); // no quote -> floor
    expect(roundupMinOut(1n, 9999)).toBe(1n); // never 0
  });
});
