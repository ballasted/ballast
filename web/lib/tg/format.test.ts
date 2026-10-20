import { describe, it, expect } from "vitest";
import {
  msgLaunch, msgSwap, msgBuyback, msgBurn, msgSplitScheduled, msgSplitApplied, msgParentBurn, msgTreasuryDeposit, msgBasketFill, msgDigest,
  splitCompact, splitLabeled, fmtWei, fmtAmount, shortAddr, esc, type Split,
} from "./format";

const TOKEN = "0x28C53790D77A23715972aE01ab7fa8430B31846f";
const TX = "0x" + "ab".repeat(32);
const split = (p: Partial<Split>): Split => ({ creatorBps: 0, treasuryBps: 0, buybackBps: 0, parentBurnBps: 0, rewardsBps: 0, ...p });

// Banned terms from the copy rules — no message may contain these.
const BANNED = /\b(floor|guaranteed|protected|safe|yield|APR|cashback|dividend|passive income|reward)\b/i;

describe("formatting primitives", () => {
  it("fmtWei scales 1e18", () => {
    expect(fmtWei(10n ** 18n)).toBe("1");
    expect(fmtWei(25n * 10n ** 16n)).toBe("0.25");
    expect(fmtWei(1_240_000n * 10n ** 18n)).toBe("1,240,000");
  });
  it("fmtAmount groups thousands", () => {
    expect(fmtAmount(116669)).toBe("116,669");
    expect(fmtAmount(0.0012)).toBe("0.0012");
  });
  it("shortAddr + esc", () => {
    expect(shortAddr(TOKEN)).toBe("0x28C5…846f");
    expect(esc("A & <b>")).toBe("A &amp; &lt;b&gt;");
  });
  it("splitCompact / splitLabeled", () => {
    expect(splitCompact(split({ creatorBps: 5000, buybackBps: 2500, rewardsBps: 2500 }))).toBe("50/25/25");
    expect(splitLabeled(split({ creatorBps: 4000, buybackBps: 3000, rewardsBps: 2000, parentBurnBps: 1000 }))).toBe("creator 40 / buyback 30 / stakers 20 / parent 10");
  });
});

describe("message builders (copy rules + shape)", () => {
  const all = [
    msgLaunch({ token: TOKEN, symbol: "NVDAI", name: "NVDA Index", pairs: ["WETH", "NVDA"], treasury: true, split: split({ creatorBps: 5000, buybackBps: 2500, rewardsBps: 2500 }), parentSymbol: "BALLAST", txHash: TX }),
    msgSwap({ side: "buy", token: TOKEN, symbol: "NVDAI", ethAmount: 0.25, tokenAmount: 1_240_000, isProtocol: false, txHash: TX }),
    msgSwap({ side: "sell", token: TOKEN, symbol: "NVDAI", ethAmount: 0.1, tokenAmount: 500_000, isProtocol: false, txHash: TX }),
    msgBuyback({ ballastBurned: 116669, asset: "WETH", spent: 0.0012, txHash: TX }),
    msgBurn({ amount: 1_000_000, from: "0x12ab34cd56ef7890ab12ab34cd56ef7890ab12ab", txHash: TX }),
    msgSplitScheduled({ token: TOKEN, symbol: "NVDAI", split: split({ creatorBps: 4000, buybackBps: 3000, rewardsBps: 2000, parentBurnBps: 1000 }), effectiveAt: 1800000000n, txHash: TX }),
    msgSplitApplied({ token: TOKEN, symbol: "NVDAI", split: split({ creatorBps: 4000, buybackBps: 6000 }), instant: true, txHash: TX }),
    msgParentBurn({ parent: TOKEN, parentSymbol: "BALLAST", parentOut: 50000, txHash: TX }),
    msgTreasuryDeposit({ token: TOKEN, symbol: "NVDAI", assetSymbol: "SGOV", amount: 1000, txHash: TX }),
    msgBasketFill({ token: TOKEN, symbol: "NVDAI", ethIn: 2, nAssets: 4, txHash: TX }),
    msgDigest(20, { swap: 18, launch: 2 }),
  ];

  it("no message contains a banned term", () => {
    for (const m of all) expect(m, m).not.toMatch(BANNED);
  });
  it("every burn message says 'sent to the dead address'", () => {
    expect(msgBuyback({ ballastBurned: 1, asset: "WETH", spent: 1, txHash: TX })).toContain("sent to the dead address");
    expect(msgBurn({ amount: 1, from: TOKEN, txHash: TX })).toContain("sent to the dead address");
    expect(msgParentBurn({ parent: TOKEN, parentOut: 1, txHash: TX })).toContain("sent to the dead address");
  });
  it("buy / sell render the expected flow", () => {
    expect(all[1]).toContain("🟢 Buy");
    expect(all[1]).toContain("0.25 ETH → 1,240,000 $NVDAI");
    expect(all[2]).toContain("🔴 Sell");
  });
  it("launch includes pairing, split, parent, and a token link", () => {
    expect(all[0]).toContain("Paired with WETH + NVDA");
    expect(all[0]).toContain("Split 50/25/25");
    expect(all[0]).toContain("Parent: $BALLAST");
    expect(all[0]).toContain(`/app/token/${TOKEN}`);
  });
  it("split scheduled shows labeled split + effective date", () => {
    expect(all[5]).toContain("creator 40 / buyback 30 / stakers 20 / parent 10");
    expect(all[5]).toContain("effective 2027-01-15");
  });
  it("every message links the tx on Blockscout", () => {
    for (const m of all.slice(0, 10)) expect(m).toMatch(/\/tx\/0x/);
  });
});
