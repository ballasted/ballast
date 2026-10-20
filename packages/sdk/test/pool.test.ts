import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import {
  poolKeyForToken,
  tokenIsCurrency0,
  buyZeroForOne,
  sellZeroForOne,
  computeMinOut,
  buildV4SwapInput,
  CMD_WRAP_ETH,
  CMD_V4_SWAP,
  CMD_UNWRAP_WETH,
  ADDRESSES,
  TICK_SPACING,
} from "../src";

const WETH = ADDRESSES.weth as Address;
const LOW = "0x0000000000000000000000000000000000000001" as Address; // sorts below WETH
const HIGH = "0xffffffffffffffffffffffffffffffffffffffff" as Address; // sorts above WETH

describe("pool key ordering", () => {
  it("sorts currencies by address", () => {
    expect(tokenIsCurrency0(LOW, WETH)).toBe(true);
    expect(tokenIsCurrency0(HIGH, WETH)).toBe(false);
  });
  it("builds a fee-0, tickSpacing-60, hooked pool key", () => {
    const k = poolKeyForToken(LOW, WETH);
    expect(k.fee).toBe(0);
    expect(k.tickSpacing).toBe(TICK_SPACING);
    expect(k.hooks.toLowerCase()).toBe(ADDRESSES.hook.toLowerCase());
    expect(k.currency0.toLowerCase()).toBe(LOW.toLowerCase());
  });
  it("zeroForOne is the mirror of buy/sell", () => {
    expect(buyZeroForOne(LOW, WETH)).toBe(!sellZeroForOne(LOW, WETH));
  });
});

describe("computeMinOut", () => {
  it("applies slippage bps", () => {
    expect(computeMinOut(1000n, 100)).toBe(990n); // 1% off
    expect(computeMinOut(1000n, 0)).toBe(1000n);
  });
  it("floors to 0 for undefined/invalid", () => {
    expect(computeMinOut(undefined, 100)).toBe(0n);
    expect(computeMinOut(0n, 100)).toBe(0n);
    expect(computeMinOut(1000n, 10000)).toBe(0n);
  });
});

describe("buildV4SwapInput (fork UniversalRouter encoding)", () => {
  it("BUY: WRAP_ETH + V4_SWAP, msg.value = amountIn", () => {
    const out = buildV4SwapInput({ token: LOW, side: "buy", amountIn: 123n, amountOutMinimum: 1n });
    expect(out.commands).toBe((CMD_WRAP_ETH + CMD_V4_SWAP.slice(2)) as `0x${string}`);
    expect(out.value).toBe(123n);
    expect(out.inputs).toHaveLength(2);
  });
  it("SELL: V4_SWAP + UNWRAP_WETH, msg.value = 0", () => {
    const out = buildV4SwapInput({ token: LOW, side: "sell", amountIn: 123n, amountOutMinimum: 1n });
    expect(out.commands).toBe((CMD_V4_SWAP + CMD_UNWRAP_WETH.slice(2)) as `0x${string}`);
    expect(out.value).toBe(0n);
    expect(out.inputs).toHaveLength(2);
  });
});
