import "server-only";
import { decodeEventLog, type Address, type Hex, type Log } from "viem";
import { poolManagerAbi } from "@/lib/abis";
import {
  ballastFactoryV5Abi,
  ballastHookV5Abi,
  protocolFeeVaultAbi,
} from "@/lib/abisV5";

// Gen-5 (Elysium, chain 99901) Telegram log decoder. SEPARATE from decode.ts:
// gen-5 event signatures differ from gen-4 (different topic0), so the gen-4
// decoder will never match these and vice-versa. Same guard discipline as
// decode.ts — decodeEventLog matches by topic0, so we re-check the decoded
// eventName before trusting the args, or a sibling event would slip through.
//
// Kinds we care about (the product "must post": launches, buys/sells, sweeps):
//   launchV5     Factory.Launched       — a new gen-5 token
//   graduatedV5  Factory.Graduated      — seeds the poolId -> {token,quoteAsset}
//                                         map (gen-5 has NO PoolSeeded event)
//   swap         PoolManager.Swap       — same event as gen-4; classified vs WHYPE
//   feeTaken     Hook.FeeTaken          — decoded for completeness (not posted)
//   sweep        ProtocolFeeVault.Forwarded — protocol share sent to the multisig

type RawLog = Pick<Log, "topics" | "data"> & {
  transactionHash?: Hex | null;
  logIndex?: number | null;
  address?: Address;
};

function dec(abi: readonly unknown[], name: string, log: RawLog): Record<string, unknown> | null {
  try {
    const d = decodeEventLog({ abi: abi as never, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
    if (d.eventName !== name) return null;
    return d.args as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type TgEventV5 =
  | { kind: "launchV5"; id: bigint; creator: Address; token: Address; feeRouter: Address; quoteAsset: Address; swapFeeBps: number; metadataURI: string }
  | { kind: "graduatedV5"; token: Address; quoteAsset: Address; poolId: Hex; openTick: number; amount: bigint }
  | { kind: "swap"; poolId: Hex; sender: Address; amount0: bigint; amount1: bigint }
  | { kind: "feeTaken"; token: Address; quoteAsset: Address; fee: bigint; creatorSide: Address; creatorCut: bigint; protocol: Address; protocolCut: bigint }
  | { kind: "sweep"; currency: Address; destination: Address; amount: bigint };

export type TgEventV5WithMeta = TgEventV5 & { txHash?: Hex; logIndex?: number; address?: Address };

export function decodeTgLogV5(log: RawLog): TgEventV5 | null {
  let a = dec(ballastFactoryV5Abi, "Launched", log);
  if (a)
    return {
      kind: "launchV5",
      id: a.id as bigint,
      creator: a.creator as Address,
      token: a.token as Address,
      feeRouter: a.feeRouter as Address,
      quoteAsset: a.quoteAsset as Address,
      swapFeeBps: Number(a.swapFeeBps),
      metadataURI: a.metadataURI as string,
    };

  a = dec(ballastFactoryV5Abi, "Graduated", log);
  if (a)
    return {
      kind: "graduatedV5",
      token: a.token as Address,
      quoteAsset: a.quoteAsset as Address,
      poolId: a.poolId as Hex,
      openTick: Number(a.openTick),
      amount: a.amount as bigint,
    };

  a = dec(poolManagerAbi, "Swap", log);
  if (a) return { kind: "swap", poolId: a.id as Hex, sender: a.sender as Address, amount0: a.amount0 as bigint, amount1: a.amount1 as bigint };

  a = dec(ballastHookV5Abi, "FeeTaken", log);
  if (a)
    return {
      kind: "feeTaken",
      token: a.token as Address,
      quoteAsset: a.quoteAsset as Address,
      fee: a.fee as bigint,
      creatorSide: a.creatorSide as Address,
      creatorCut: a.creatorCut as bigint,
      protocol: a.protocol as Address,
      protocolCut: a.protocolCut as bigint,
    };

  a = dec(protocolFeeVaultAbi, "Forwarded", log);
  if (a) return { kind: "sweep", currency: a.currency as Address, destination: a.destination as Address, amount: a.amount as bigint };

  return null;
}
