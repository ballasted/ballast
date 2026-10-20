import {
  decodeEventLog,
  type Address,
  type Hex,
  type Log,
} from "viem";
import {
  ballastFactoryAbi,
  buybackBurnerV2Abi,
  feeRouterV2Abi,
  projectTreasuryAbi,
  basketZapAbi,
  ballastTokenAbi,
} from "./constants/abis";

// Typed decoders for the on-chain events the SDK and the Telegram bot (Phase 2)
// care about. Each decoder takes a raw viem Log and returns a structured object,
// or null when the log isn't that event (wrong selector / topic count). Nothing
// here hits the network — pass logs you already fetched/watched.

/** The minimal v4 PoolManager Swap event (no standalone compiled artifact — this
 *  is the canonical v4-core shape, matching lib/abis.ts poolManagerAbi). */
export const poolManagerSwapAbi = [
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

type RawLog = Pick<Log, "topics" | "data"> & {
  transactionHash?: Hex | null;
  logIndex?: number | null;
  address?: Address;
};

function tryDecode<const TAbi extends readonly unknown[]>(
  abi: TAbi,
  eventName: string,
  log: RawLog,
) {
  try {
    const decoded = decodeEventLog({
      abi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data as Hex,
    });
    // decodeEventLog matches by topic0, not the eventName hint — so a same-contract
    // sibling event (e.g. Approval vs Transfer) would otherwise slip through. Only
    // accept the event we actually asked for.
    if (decoded.eventName !== eventName) return null;
    return decoded.args as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discriminated union of everything we decode
// ─────────────────────────────────────────────────────────────────────────────
export type BallastEvent =
  | { kind: "launch"; id: bigint; creator: Address; token: Address; treasury: Address; noticePeriod: bigint; metadataURI: string }
  | { kind: "graduated"; token: Address; treasury: Address; backingUsd1e18: bigint }
  | { kind: "poolSeeded"; token: Address; quoteAsset: Address; poolId: Hex; openTick: number; amount: bigint }
  | { kind: "swap"; poolId: Hex; sender: Address; amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number; fee: number }
  | { kind: "buybackBurned"; caller: Address; asset: Address; spent: bigint; ballastBought: bigint; totalBallastBurned: bigint }
  | { kind: "deadTransfer"; token: Address; from: Address; value: bigint }
  | { kind: "splitScheduled"; creatorBps: number; treasuryBps: number; buybackBps: number; parentBurnBps: number; rewardsBps: number; effectiveAt: bigint }
  | { kind: "splitApplied"; creatorBps: number; treasuryBps: number; buybackBps: number; parentBurnBps: number; rewardsBps: number; instant: boolean }
  | { kind: "parentBurned"; parent: Address; wethIn: bigint; parentOut: bigint }
  | { kind: "treasuryDeposit"; asset: Address; amount: bigint; depositor?: Address; variant: "creator" | "accepted" }
  | { kind: "basketFill"; launchToken: Address; creator: Address; ethIn: bigint; ethRefunded: bigint; assets: readonly Address[]; weightsBps: readonly number[]; amountsOut: readonly bigint[] };

// ── Individual decoders ──

export function decodeLaunch(log: RawLog): Extract<BallastEvent, { kind: "launch" }> | null {
  const a = tryDecode(ballastFactoryAbi, "Launched", log);
  if (!a) return null;
  return {
    kind: "launch",
    id: a.id as bigint,
    creator: a.creator as Address,
    token: a.token as Address,
    treasury: a.treasury as Address,
    noticePeriod: a.noticePeriod as bigint,
    metadataURI: a.metadataURI as string,
  };
}

export function decodeGraduated(log: RawLog): Extract<BallastEvent, { kind: "graduated" }> | null {
  const a = tryDecode(ballastFactoryAbi, "Graduated", log);
  if (!a) return null;
  return { kind: "graduated", token: a.token as Address, treasury: a.treasury as Address, backingUsd1e18: a.backingUsd1e18 as bigint };
}

export function decodePoolSeeded(log: RawLog): Extract<BallastEvent, { kind: "poolSeeded" }> | null {
  const a = tryDecode(ballastFactoryAbi, "PoolSeeded", log);
  if (!a) return null;
  return { kind: "poolSeeded", token: a.token as Address, quoteAsset: a.quoteAsset as Address, poolId: a.poolId as Hex, openTick: Number(a.openTick), amount: a.amount as bigint };
}

export function decodeSwap(log: RawLog): Extract<BallastEvent, { kind: "swap" }> | null {
  const a = tryDecode(poolManagerSwapAbi, "Swap", log);
  if (!a) return null;
  return {
    kind: "swap",
    poolId: a.id as Hex,
    sender: a.sender as Address,
    amount0: a.amount0 as bigint,
    amount1: a.amount1 as bigint,
    sqrtPriceX96: a.sqrtPriceX96 as bigint,
    liquidity: a.liquidity as bigint,
    tick: Number(a.tick),
    fee: Number(a.fee),
  };
}

export function decodeBuybackBurned(log: RawLog): Extract<BallastEvent, { kind: "buybackBurned" }> | null {
  const a = tryDecode(buybackBurnerV2Abi, "BuybackBurned", log);
  if (!a) return null;
  return {
    kind: "buybackBurned",
    caller: a.caller as Address,
    asset: a.asset as Address,
    spent: a.spent as bigint,
    ballastBought: a.ballastBought as bigint,
    totalBallastBurned: a.totalBallastBurned as bigint,
  };
}

const DEAD = "0x000000000000000000000000000000000000dead";

/** Decode an ERC-20 Transfer ONLY when it is a burn (to the dead address). */
export function decodeDeadTransfer(log: RawLog): Extract<BallastEvent, { kind: "deadTransfer" }> | null {
  const a = tryDecode(ballastTokenAbi, "Transfer", log);
  if (!a) return null;
  if ((a.to as Address).toLowerCase() !== DEAD) return null;
  return { kind: "deadTransfer", token: (log.address ?? "0x") as Address, from: a.from as Address, value: a.value as bigint };
}

export function decodeSplitScheduled(log: RawLog): Extract<BallastEvent, { kind: "splitScheduled" }> | null {
  const a = tryDecode(feeRouterV2Abi, "SplitScheduled", log);
  if (!a) return null;
  return {
    kind: "splitScheduled",
    creatorBps: Number(a.creatorBps),
    treasuryBps: Number(a.treasuryBps),
    buybackBps: Number(a.buybackBps),
    parentBurnBps: Number(a.parentBurnBps),
    rewardsBps: Number(a.rewardsBps),
    effectiveAt: a.effectiveAt as bigint,
  };
}

export function decodeSplitApplied(log: RawLog): Extract<BallastEvent, { kind: "splitApplied" }> | null {
  // Two on-chain shapes: SplitApplied (scheduled delay elapsed) and
  // SplitAppliedInstant (creator share lowered — no delay). Normalize to one.
  const a = tryDecode(feeRouterV2Abi, "SplitApplied", log);
  if (a) {
    return { kind: "splitApplied", creatorBps: Number(a.creatorBps), treasuryBps: Number(a.treasuryBps), buybackBps: Number(a.buybackBps), parentBurnBps: Number(a.parentBurnBps), rewardsBps: Number(a.rewardsBps), instant: false };
  }
  const b = tryDecode(feeRouterV2Abi, "SplitAppliedInstant", log);
  if (b) {
    return { kind: "splitApplied", creatorBps: Number(b.creatorBps), treasuryBps: Number(b.treasuryBps), buybackBps: Number(b.buybackBps), parentBurnBps: Number(b.parentBurnBps), rewardsBps: Number(b.rewardsBps), instant: true };
  }
  return null;
}

export function decodeParentBurned(log: RawLog): Extract<BallastEvent, { kind: "parentBurned" }> | null {
  const a = tryDecode(feeRouterV2Abi, "ParentBurned", log);
  if (!a) return null;
  return { kind: "parentBurned", parent: a.parent as Address, wethIn: a.wethIn as bigint, parentOut: a.parentOut as bigint };
}

export function decodeTreasuryDeposit(log: RawLog): Extract<BallastEvent, { kind: "treasuryDeposit" }> | null {
  const a = tryDecode(projectTreasuryAbi, "CreatorDeposited", log);
  if (a) return { kind: "treasuryDeposit", asset: a.asset as Address, amount: a.amount as bigint, variant: "creator" };
  const b = tryDecode(projectTreasuryAbi, "DepositAccepted", log);
  if (b) return { kind: "treasuryDeposit", asset: b.asset as Address, amount: b.amount as bigint, depositor: b.depositor as Address, variant: "accepted" };
  return null;
}

export function decodeBasketFill(log: RawLog): Extract<BallastEvent, { kind: "basketFill" }> | null {
  const a = tryDecode(basketZapAbi, "BasketSwapped", log);
  if (!a) return null;
  return {
    kind: "basketFill",
    launchToken: a.launchToken as Address,
    creator: a.creator as Address,
    ethIn: a.ethIn as bigint,
    ethRefunded: a.ethRefunded as bigint,
    assets: a.assets as readonly Address[],
    weightsBps: (a.weightsBps as readonly (number | bigint)[]).map(Number),
    amountsOut: a.amountsOut as readonly bigint[],
  };
}

const ALL_DECODERS = [
  decodeLaunch,
  decodeGraduated,
  decodePoolSeeded,
  decodeSwap,
  decodeBuybackBurned,
  decodeDeadTransfer,
  decodeSplitScheduled,
  decodeSplitApplied,
  decodeParentBurned,
  decodeTreasuryDeposit,
  decodeBasketFill,
] as const;

/** Classify a batch of raw logs into typed Ballast events. Logs that match no
 *  known Ballast event are dropped. Order is preserved. */
export function parseBallastLogs(logs: RawLog[]): Array<BallastEvent & { txHash?: Hex; logIndex?: number; address?: Address }> {
  const out: Array<BallastEvent & { txHash?: Hex; logIndex?: number; address?: Address }> = [];
  for (const log of logs) {
    for (const d of ALL_DECODERS) {
      const ev = d(log);
      if (ev) {
        out.push({ ...ev, txHash: log.transactionHash ?? undefined, logIndex: log.logIndex ?? undefined, address: log.address });
        break;
      }
    }
  }
  return out;
}
