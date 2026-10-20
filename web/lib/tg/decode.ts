import "server-only";
import { decodeEventLog, type Address, type Hex, type Log } from "viem";
import {
  ballastFactoryAbi,
  poolManagerAbi,
  feeRouterV2Abi,
  projectTreasuryAbi,
  ballastTokenAbi,
} from "@/lib/abis";
import { basketZapAbi } from "@/lib/basketZapAbi";

// Minimal BuybackBurnerV2 event ABI (the full ABI lives in a client hook; a server
// route must not import that). Matches contracts/src/BuybackBurnerV2.sol.
export const buybackBurnedAbi = [
  {
    type: "event",
    name: "BuybackBurned",
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: true },
      { name: "spent", type: "uint256", indexed: false },
      { name: "ballastBought", type: "uint256", indexed: false },
      { name: "totalBallastBurned", type: "uint256", indexed: false },
    ],
  },
] as const;

// Mirror of packages/sdk/src/events.ts `parseBallastLogs` — IDENTICAL decode
// logic, but importing the web app's own ABIs so the Vercel build stays
// self-contained (no cross-package dependency on the unbuilt SDK). Keep the two in
// sync; both guard on the decoded eventName because decodeEventLog matches by
// topic0, so a sibling event (Approval vs Transfer) would otherwise slip through.

const DEAD = "0x000000000000000000000000000000000000dead";

type RawLog = Pick<Log, "topics" | "data"> & { transactionHash?: Hex | null; logIndex?: number | null; address?: Address };

function dec(abi: readonly unknown[], name: string, log: RawLog): Record<string, unknown> | null {
  try {
    const d = decodeEventLog({ abi: abi as never, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
    if (d.eventName !== name) return null;
    return d.args as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type TgEvent =
  | { kind: "launch"; id: bigint; creator: Address; token: Address; treasury: Address; noticePeriod: bigint; metadataURI: string }
  | { kind: "poolSeeded"; token: Address; quoteAsset: Address; poolId: Hex; amount: bigint }
  | { kind: "swap"; poolId: Hex; sender: Address; amount0: bigint; amount1: bigint }
  | { kind: "buybackBurned"; caller: Address; asset: Address; spent: bigint; ballastBought: bigint; totalBallastBurned: bigint }
  | { kind: "deadTransfer"; token: Address; from: Address; value: bigint }
  | { kind: "splitScheduled"; router: Address; creatorBps: number; treasuryBps: number; buybackBps: number; parentBurnBps: number; rewardsBps: number; effectiveAt: bigint }
  | { kind: "splitApplied"; router: Address; creatorBps: number; treasuryBps: number; buybackBps: number; parentBurnBps: number; rewardsBps: number; instant: boolean }
  | { kind: "parentBurned"; router: Address; parent: Address; wethIn: bigint; parentOut: bigint }
  | { kind: "treasuryDeposit"; treasury: Address; asset: Address; amount: bigint; variant: "creator" | "accepted" }
  | { kind: "basketFill"; launchToken: Address; ethIn: bigint; ethRefunded: bigint; assets: readonly Address[]; weightsBps: readonly number[] };

export type TgEventWithMeta = TgEvent & { txHash?: Hex; logIndex?: number; address?: Address };

export function decodeTgLog(log: RawLog): TgEvent | null {
  let a = dec(ballastFactoryAbi, "Launched", log);
  if (a) return { kind: "launch", id: a.id as bigint, creator: a.creator as Address, token: a.token as Address, treasury: a.treasury as Address, noticePeriod: a.noticePeriod as bigint, metadataURI: a.metadataURI as string };

  a = dec(ballastFactoryAbi, "PoolSeeded", log);
  if (a) return { kind: "poolSeeded", token: a.token as Address, quoteAsset: a.quoteAsset as Address, poolId: a.poolId as Hex, amount: a.amount as bigint };

  a = dec(poolManagerAbi, "Swap", log);
  if (a) return { kind: "swap", poolId: a.id as Hex, sender: a.sender as Address, amount0: a.amount0 as bigint, amount1: a.amount1 as bigint };

  a = dec(buybackBurnedAbi, "BuybackBurned", log);
  if (a) return { kind: "buybackBurned", caller: a.caller as Address, asset: a.asset as Address, spent: a.spent as bigint, ballastBought: a.ballastBought as bigint, totalBallastBurned: a.totalBallastBurned as bigint };

  a = dec(ballastTokenAbi, "Transfer", log);
  if (a && (a.to as Address).toLowerCase() === DEAD) return { kind: "deadTransfer", token: (log.address ?? "0x") as Address, from: a.from as Address, value: a.value as bigint };

  a = dec(feeRouterV2Abi, "SplitScheduled", log);
  if (a) return { kind: "splitScheduled", router: (log.address ?? "0x") as Address, creatorBps: Number(a.creatorBps), treasuryBps: Number(a.treasuryBps), buybackBps: Number(a.buybackBps), parentBurnBps: Number(a.parentBurnBps), rewardsBps: Number(a.rewardsBps), effectiveAt: a.effectiveAt as bigint };

  a = dec(feeRouterV2Abi, "SplitApplied", log);
  if (a) return { kind: "splitApplied", router: (log.address ?? "0x") as Address, creatorBps: Number(a.creatorBps), treasuryBps: Number(a.treasuryBps), buybackBps: Number(a.buybackBps), parentBurnBps: Number(a.parentBurnBps), rewardsBps: Number(a.rewardsBps), instant: false };
  a = dec(feeRouterV2Abi, "SplitAppliedInstant", log);
  if (a) return { kind: "splitApplied", router: (log.address ?? "0x") as Address, creatorBps: Number(a.creatorBps), treasuryBps: Number(a.treasuryBps), buybackBps: Number(a.buybackBps), parentBurnBps: Number(a.parentBurnBps), rewardsBps: Number(a.rewardsBps), instant: true };

  a = dec(feeRouterV2Abi, "ParentBurned", log);
  if (a) return { kind: "parentBurned", router: (log.address ?? "0x") as Address, parent: a.parent as Address, wethIn: a.wethIn as bigint, parentOut: a.parentOut as bigint };

  a = dec(projectTreasuryAbi, "CreatorDeposited", log);
  if (a) return { kind: "treasuryDeposit", treasury: (log.address ?? "0x") as Address, asset: a.asset as Address, amount: a.amount as bigint, variant: "creator" };
  a = dec(projectTreasuryAbi, "DepositAccepted", log);
  if (a) return { kind: "treasuryDeposit", treasury: (log.address ?? "0x") as Address, asset: a.asset as Address, amount: a.amount as bigint, variant: "accepted" };

  a = dec(basketZapAbi, "BasketSwapped", log);
  if (a) return { kind: "basketFill", launchToken: a.launchToken as Address, ethIn: a.ethIn as bigint, ethRefunded: a.ethRefunded as bigint, assets: a.assets as readonly Address[], weightsBps: (a.weightsBps as readonly (number | bigint)[]).map(Number) };

  return null;
}
