import { describe, it, expect } from "vitest";
import { encodeEventTopics, encodeAbiParameters, getAbiItem, type AbiEvent, type AbiParameter, type Hex } from "viem";
import { poolManagerAbi } from "@/lib/abis";
import { ballastFactoryV5Abi, protocolFeeVaultAbi } from "@/lib/abisV5";
import { decodeTgLogV5 } from "./decodeV5";
import { msgLaunch, msgSwap, msgSweep } from "./format";

const TOKEN = "0x28C53790D77A23715972aE01ab7fa8430B31846f" as const;
const QUOTE = "0xbA876237B0F021A6c6D852d6c26E107997cC5E81" as const; // WHYPE
const ADDR = "0x1111111111111111111111111111111111111111" as const;
const SAFE = "0xa4dCbAd7A34da4473040d9f0fE35990c458A727C" as const;
const POOL = ("0x" + "cd".repeat(32)) as Hex;
const TX = ("0x" + "ab".repeat(32)) as Hex;

// Build a raw log (topics+data) the way viem's getLogs returns it, then feed it
// through the gen-5 decoder — so the decoder is exercised end-to-end, not mocked.
// (This viem build does not export encodeEventLog, so topics come from
// encodeEventTopics and data from the non-indexed inputs.)
function raw(abi: readonly unknown[], eventName: string, args: Record<string, unknown>) {
  const event = getAbiItem({ abi: abi as never, name: eventName as never }) as unknown as AbiEvent;
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never);
  const nonIndexed = (event.inputs ?? []).filter((i) => !i.indexed) as AbiParameter[];
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name as string]));
  return { topics, data } as { topics: [Hex, ...Hex[]]; data: Hex };
}

describe("decodeTgLogV5", () => {
  it("decodes a gen-5 Launched", () => {
    const log = raw(ballastFactoryV5Abi, "Launched", {
      id: 1n, creator: ADDR, token: TOKEN, feeRouter: ADDR, quoteAsset: QUOTE, swapFeeBps: 100, metadataURI: "ipfs://x",
    });
    const ev = decodeTgLogV5(log);
    expect(ev?.kind).toBe("launchV5");
    if (ev?.kind === "launchV5") {
      expect(ev.token).toBe(TOKEN);
      expect(ev.quoteAsset).toBe(QUOTE);
      expect(ev.swapFeeBps).toBe(100);
    }
  });

  it("decodes a gen-5 Graduated (pool map source)", () => {
    const log = raw(ballastFactoryV5Abi, "Graduated", { token: TOKEN, quoteAsset: QUOTE, poolId: POOL, openTick: -100, amount: 5n });
    const ev = decodeTgLogV5(log);
    expect(ev?.kind).toBe("graduatedV5");
    if (ev?.kind === "graduatedV5") {
      expect(ev.poolId.toLowerCase()).toBe(POOL.toLowerCase());
      expect(ev.token).toBe(TOKEN);
      expect(ev.openTick).toBe(-100);
    }
  });

  it("decodes a PoolManager Swap", () => {
    const log = raw(poolManagerAbi, "Swap", {
      id: POOL, sender: ADDR, amount0: -5n, amount1: 10n, sqrtPriceX96: 0n, liquidity: 0n, tick: 0, fee: 0,
    });
    const ev = decodeTgLogV5(log);
    expect(ev?.kind).toBe("swap");
    if (ev?.kind === "swap") {
      expect(ev.amount0).toBe(-5n);
      expect(ev.amount1).toBe(10n);
    }
  });

  it("decodes a ProtocolFeeVault Forwarded (sweep)", () => {
    const log = raw(protocolFeeVaultAbi, "Forwarded", { currency: QUOTE, destination: SAFE, amount: 42n });
    const ev = decodeTgLogV5(log);
    expect(ev?.kind).toBe("sweep");
    if (ev?.kind === "sweep") {
      expect(ev.currency).toBe(QUOTE);
      expect(ev.destination).toBe(SAFE);
      expect(ev.amount).toBe(42n);
    }
  });

  it("returns null for an unrelated log", () => {
    const log = raw(protocolFeeVaultAbi, "Collected", { currency: QUOTE, amount: 1n });
    // Collected is not one of the posted/mapped kinds.
    expect(decodeTgLogV5(log)).toBeNull();
  });
});

// Banned terms from the copy rules — no message may contain these.
const BANNED = /\b(floor|guaranteed|protected|safe|yield|APR|cashback|dividend|passive income|reward)\b/i;

describe("Elysium (gen-5) formatting — WHYPE/HYPE + prefix + elyscan", () => {
  const CTX = { prefix: "Elysium · Gen 5 beta", explorer: "https://elyscan.live" } as const;

  it("buy renders HYPE (not ETH) and the Elysium prefix", () => {
    const m = msgSwap({ ...CTX, side: "buy", token: TOKEN, symbol: "ABC", ethAmount: 0.25, tokenAmount: 1000, isProtocol: false, txHash: TX, nativeSymbol: "HYPE" });
    expect(m).toContain("Elysium · Gen 5 beta ·");
    expect(m).toContain("0.25 HYPE → 1,000 $ABC");
    expect(m).not.toContain(" ETH");
    expect(m).toContain("https://elyscan.live/tx/");
    expect(m).not.toMatch(BANNED);
  });

  it("launch pairs with WHYPE and links elyscan", () => {
    const m = msgLaunch({ ...CTX, token: TOKEN, symbol: "ABC", pairs: ["WHYPE"], treasury: false, split: { creatorBps: 10000, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0 }, txHash: TX, quoteSymbol: "WHYPE" });
    expect(m).toContain("Elysium · Gen 5 beta ·");
    expect(m).toContain("Paired with WHYPE");
    expect(m).toContain("https://elyscan.live/tx/");
    expect(m).not.toMatch(BANNED);
  });

  it("sweep says protocol share forwarded to the Ballast multisig (no banned 'safe')", () => {
    const m = msgSweep({ ...CTX, assetSymbol: "WHYPE", amount: 1.5, txHash: TX });
    expect(m).toContain("Protocol share forwarded to the Ballast multisig");
    expect(m).toContain("1.5 WHYPE");
    expect(m).not.toMatch(BANNED);
  });
});
