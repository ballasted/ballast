import { describe, it, expect } from "vitest";
import { encodeEventTopics, encodeAbiParameters, getAbiItem, getAddress, type Address, type AbiEvent } from "viem";
import {
  parseBallastLogs,
  decodeLaunch,
  decodeSwap,
  decodeBuybackBurned,
  decodeDeadTransfer,
  decodeSplitScheduled,
  decodeBasketFill,
  poolManagerSwapAbi,
  ballastFactoryAbi,
  buybackBurnerV2Abi,
  feeRouterV2Abi,
  basketZapAbi,
  ballastTokenAbi,
} from "../src";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const DEAD = getAddress("0x000000000000000000000000000000000000dEaD") as Address;
const TOKEN = A(0xabc);

// Round-trip: encode a real event with the SAME ABI the decoder uses, then assert
// the decoder reconstructs the fields. This verifies topic/data layout without a
// live chain, and would catch any ABI drift that breaks decoding.
function mkLog(abi: readonly unknown[], eventName: string, args: Record<string, unknown>, address: Address) {
  const topics = encodeEventTopics({ abi: abi as never, eventName: eventName as never, args: args as never });
  const item = getAbiItem({ abi: abi as never, name: eventName as never }) as unknown as AbiEvent;
  const nonIndexed = item.inputs.filter((i) => !("indexed" in i && i.indexed));
  const data = nonIndexed.length ? encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!])) : "0x";
  return { data: data as `0x${string}`, topics: topics as [`0x${string}`, ...`0x${string}`[]], address, transactionHash: ("0x" + "11".repeat(32)) as `0x${string}`, logIndex: 0 };
}

describe("event decoders (round-trip)", () => {
  it("decodes Launched", () => {
    const log = mkLog(ballastFactoryAbi, "Launched", { id: 7n, creator: A(1), token: TOKEN, treasury: A(2), noticePeriod: 86400n, metadataURI: "ipfs://x" }, A(0xf4));
    const ev = decodeLaunch(log);
    expect(ev).toMatchObject({ kind: "launch", id: 7n, token: TOKEN, treasury: A(2), noticePeriod: 86400n, metadataURI: "ipfs://x" });
  });

  it("decodes a v4 Swap", () => {
    const log = mkLog(poolManagerSwapAbi, "Swap", { id: ("0x" + "22".repeat(32)) as `0x${string}`, sender: A(3), amount0: -100n, amount1: 250n, sqrtPriceX96: 123n, liquidity: 99n, tick: -5, fee: 0 }, A(0x9));
    const ev = decodeSwap(log);
    expect(ev).toMatchObject({ kind: "swap", amount0: -100n, amount1: 250n, tick: -5, fee: 0 });
  });

  it("decodes BuybackBurned", () => {
    const log = mkLog(buybackBurnerV2Abi, "BuybackBurned", { caller: A(4), asset: A(5), spent: 12n, ballastBought: 34n, totalBallastBurned: 56n }, A(0xbb));
    expect(decodeBuybackBurned(log)).toMatchObject({ kind: "buybackBurned", spent: 12n, ballastBought: 34n, totalBallastBurned: 56n });
  });

  it("decodes a Transfer to dead ONLY (ignores other transfers)", () => {
    const toDead = mkLog(ballastTokenAbi, "Transfer", { from: A(6), to: DEAD, value: 1000n }, TOKEN);
    expect(decodeDeadTransfer(toDead)).toMatchObject({ kind: "deadTransfer", from: A(6), value: 1000n, token: TOKEN });
    const toUser = mkLog(ballastTokenAbi, "Transfer", { from: A(6), to: A(7), value: 1000n }, TOKEN);
    expect(decodeDeadTransfer(toUser)).toBeNull();
  });

  it("decodes SplitScheduled", () => {
    const log = mkLog(feeRouterV2Abi, "SplitScheduled", { creatorBps: 4000, treasuryBps: 0, buybackBps: 3000, parentBurnBps: 1000, rewardsBps: 2000, effectiveAt: 1800000000n }, A(0x5e));
    expect(decodeSplitScheduled(log)).toMatchObject({ kind: "splitScheduled", creatorBps: 4000, buybackBps: 3000, parentBurnBps: 1000, rewardsBps: 2000, effectiveAt: 1800000000n });
  });

  it("decodes BasketSwapped", () => {
    const log = mkLog(basketZapAbi, "BasketSwapped", { launchToken: TOKEN, creator: A(1), ethIn: 10n, ethRefunded: 1n, assets: [A(2), A(3)], weightsBps: [6000, 4000], amountsOut: [5n, 6n], usedFables: [true, false] }, A(0xba));
    expect(decodeBasketFill(log)).toMatchObject({ kind: "basketFill", launchToken: TOKEN, ethIn: 10n, ethRefunded: 1n, weightsBps: [6000, 4000] });
  });

  it("parseBallastLogs classifies a mixed batch and drops unknown logs", () => {
    const logs = [
      mkLog(ballastFactoryAbi, "Launched", { id: 1n, creator: A(1), token: TOKEN, treasury: A(2), noticePeriod: 0n, metadataURI: "" }, A(0xf4)),
      mkLog(buybackBurnerV2Abi, "BuybackBurned", { caller: A(4), asset: A(5), spent: 1n, ballastBought: 2n, totalBallastBurned: 3n }, A(0xbb)),
      // an Approval event is not in our decoder set → dropped
      mkLog(ballastTokenAbi, "Approval", { owner: A(1), spender: A(2), value: 5n }, TOKEN),
    ];
    const out = parseBallastLogs(logs);
    expect(out.map((e) => e.kind)).toEqual(["launch", "buybackBurned"]);
    expect(out[0]).toHaveProperty("txHash");
  });
});
