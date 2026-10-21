import type { Address } from "viem";
import type { Ctx } from "./client";
import {
  ballastFactoryAbi,
  buybackBurnerV2Abi,
  backingLensAbi,
  feeRouterFactoryAbi,
  feeRouterV2Abi,
} from "./constants/abis";
import { ALL_FACTORIES } from "./constants/addresses";
import { isHiddenToken } from "./constants/hidden-tokens";
import { decodeLaunch } from "./events";
import { NotFoundError } from "./errors";

const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Factory -> hook generation. The current factory is gen-4; prior generations are
// mapped from lib/contracts.ts FACTORY_FEE_CONFIGS. Unknown factories report
// undefined rather than a guess.
const FACTORY_GEN: Record<string, number> = {
  "0xa32b9870a1b77544eb4e044cae9f3e62a1f71f67": 4,
  "0x069974136c78cf0f2162463b95321e59f56523d8": 1,
  "0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1": 2,
  "0x3eb5532e982931cad40d0416adbd7930a57965ae": 3,
};

export interface FeeSplit {
  creatorBps: number;
  treasuryBps: number;
  buybackBps: number;
  parentBurnBps: number;
  rewardsBps: number;
}

export interface TokenInfo {
  token: Address;
  name?: string;
  symbol?: string;
  decimals: number;
  totalSupply: bigint;
  hidden: boolean;
  ownerFactory?: Address;
  hookGen?: number;
  graduated: boolean;
  treasury?: Address;
  creator?: Address;
  quoteAssets: Address[];
  backing?: {
    totalSupply: bigint;
    totalValueUsd: bigint;
    backingPerToken: bigint;
    anyStale: boolean;
    anyUnpriced: boolean;
    sequencerStatus: number;
  };
  feeRouter?: {
    router: Address;
    version: 1 | 2;
    parent?: Address;
    currentSplit: FeeSplit;
    pendingSplit?: FeeSplit & { effectiveAt: bigint };
  };
}

/** Find which factory launched `token` (launchIdOf != 0), newest-first. */
async function resolveOwnerFactory(ctx: Ctx, token: Address): Promise<{ factory: Address; id: bigint } | null> {
  for (const factory of [ctx.addr.factory, ...ALL_FACTORIES.filter((f) => f !== ctx.addr.factory)]) {
    try {
      const idPlus1 = (await ctx.pub.readContract({ address: factory, abi: ballastFactoryAbi, functionName: "launchIdOf", args: [token] })) as bigint;
      if (idPlus1 > 0n) return { factory, id: idPlus1 - 1n };
    } catch {
      /* factory predates launchIdOf — skip */
    }
  }
  return null;
}

/**
 * Resolve a token's FeeRouter by scanning FeeRouterCreated across both factories
 * from `fromBlock`, then matching each candidate router's own `token()`. Returns
 * the current + any pending scheduled split and the family parent.
 */
export async function getFeeRouter(ctx: Ctx, token: Address, opts: { fromBlock?: bigint; toBlock?: bigint } = {}): Promise<TokenInfo["feeRouter"] | undefined> {
  const factories: { address: Address; version: 1 | 2 }[] = [
    { address: ctx.addr.feeRouterFactoryV2, version: 2 },
    { address: ctx.addr.feeRouterFactory, version: 1 },
  ];
  const fromBlock = opts.fromBlock ?? 0n;
  const toBlock = opts.toBlock ?? "latest";
  const event = feeRouterFactoryAbi.find((x: { type: string; name?: string }) => x.type === "event" && x.name === "FeeRouterCreated");
  for (const f of factories) {
    let logs;
    try {
      logs = await ctx.pub.getLogs({ address: f.address, event: event as never, fromBlock, toBlock: toBlock as never });
    } catch {
      continue;
    }
    for (const log of logs) {
      const router = (log as { args: { router?: Address } }).args.router;
      if (!router) continue;
      try {
        const rtoken = (await ctx.pub.readContract({ address: router, abi: feeRouterV2Abi, functionName: "token" })) as Address;
        if (rtoken.toLowerCase() !== token.toLowerCase()) continue;
      } catch {
        continue;
      }
      // Matched. Read split + pending + parent (v2 ABI is a superset; v1 ignores pending fields).
      const read = (functionName: string) => ctx.pub.readContract({ address: router, abi: feeRouterV2Abi, functionName: functionName as never }).catch(() => undefined);
      const [creatorBps, treasuryBps, buybackBps, parentBurnBps, rewardsBps, parent, hasPending] = (await Promise.all([
        read("creatorBps"), read("treasuryBps"), read("buybackBps"), read("parentBurnBps"), read("rewardsBps"), read("parent"), read("hasPendingSplit"),
      ])) as unknown as [number, number, number, number, number, Address, boolean];
      const currentSplit: FeeSplit = {
        creatorBps: Number(creatorBps ?? 0), treasuryBps: Number(treasuryBps ?? 0), buybackBps: Number(buybackBps ?? 0),
        parentBurnBps: Number(parentBurnBps ?? 0), rewardsBps: Number(rewardsBps ?? 0),
      };
      let pendingSplit: (FeeSplit & { effectiveAt: bigint }) | undefined;
      if (hasPending) {
        const [pc, pt, pb, pp, pr, eff] = (await Promise.all([
          read("pendingCreatorBps"), read("pendingTreasuryBps"), read("pendingBuybackBps"), read("pendingParentBurnBps"), read("pendingRewardsBps"), read("pendingEffectiveAt"),
        ])) as unknown as [number, number, number, number, number, bigint];
        pendingSplit = { creatorBps: Number(pc ?? 0), treasuryBps: Number(pt ?? 0), buybackBps: Number(pb ?? 0), parentBurnBps: Number(pp ?? 0), rewardsBps: Number(pr ?? 0), effectiveAt: (eff ?? 0n) as bigint };
      }
      return { router, version: f.version, parent: parent && parent !== "0x0000000000000000000000000000000000000000" ? parent : undefined, currentSplit, pendingSplit };
    }
  }
  return undefined;
}

export interface GetTokenOpts {
  /** Scan FeeRouterCreated from this block to resolve the token's router/split.
   *  Omit to skip the (potentially large) scan — feeRouter will be undefined. */
  feeRouterFromBlock?: bigint;
}

/** Full read of a Ballast token: identity, pools, gen, treasury/backing, fee router. */
export async function getToken(ctx: Ctx, token: Address, opts: GetTokenOpts = {}): Promise<TokenInfo> {
  const owner = await resolveOwnerFactory(ctx, token);
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    ctx.pub.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => undefined) as Promise<string | undefined>,
    ctx.pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => undefined) as Promise<string | undefined>,
    ctx.pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18) as Promise<number>,
    ctx.pub.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n) as Promise<bigint>,
  ]);
  if (!owner && name === undefined && symbol === undefined) {
    throw new NotFoundError(`No contract/token found at ${token} on this chain.`);
  }

  let treasury: Address | undefined;
  let creator: Address | undefined;
  let graduated = false;
  let quoteAssets: Address[] = [];
  if (owner) {
    try {
      const l = (await ctx.pub.readContract({ address: owner.factory, abi: ballastFactoryAbi, functionName: "launches", args: [owner.id] })) as [Address, Address, Address];
      treasury = l[1];
      creator = l[2];
    } catch { /* ignore */ }
    graduated = ((await ctx.pub.readContract({ address: owner.factory, abi: ballastFactoryAbi, functionName: "graduated", args: [token] }).catch(() => false)) as boolean) ?? false;
    quoteAssets = ((await ctx.pub.readContract({ address: owner.factory, abi: ballastFactoryAbi, functionName: "quoteAssetsOf", args: [token] }).catch(() => [])) as Address[]) ?? [];
  }

  let backing: TokenInfo["backing"];
  if (treasury) {
    try {
      const b = (await ctx.pub.readContract({ address: ctx.addr.backingLens, abi: backingLensAbi, functionName: "backingOf", args: [treasury] })) as {
        sequencerStatus: number; totalSupply: bigint; totalValueUsd: bigint; backingPerToken: bigint; anyStale: boolean; anyUnpriced: boolean;
      };
      backing = {
        totalSupply: b.totalSupply, totalValueUsd: b.totalValueUsd, backingPerToken: b.backingPerToken,
        anyStale: b.anyStale, anyUnpriced: b.anyUnpriced, sequencerStatus: Number(b.sequencerStatus),
      };
    } catch { /* treasury reads can be absent — leave undefined */ }
  }

  const feeRouter = opts.feeRouterFromBlock !== undefined ? await getFeeRouter(ctx, token, { fromBlock: opts.feeRouterFromBlock }) : undefined;

  return {
    token,
    name, symbol, decimals: Number(decimals ?? 18), totalSupply: totalSupply ?? 0n,
    hidden: isHiddenToken(token),
    ownerFactory: owner?.factory,
    hookGen: owner ? FACTORY_GEN[owner.factory.toLowerCase()] : undefined,
    graduated, treasury, creator, quoteAssets,
    backing, feeRouter,
  };
}

export interface LaunchRecord {
  id: bigint;
  factory: Address;
  token: Address;
  treasury: Address;
  creator: Address;
  noticePeriod: bigint;
  metadataURI: string;
  blockNumber: bigint;
  txHash?: `0x${string}`;
}

/** Enumerate launches from factory Launched events across all factories. Hidden
 *  (test/smoke) tokens are filtered out (unless includeHidden). */
export async function listLaunches(ctx: Ctx, opts: { fromBlock?: bigint; toBlock?: bigint; includeHidden?: boolean } = {}): Promise<LaunchRecord[]> {
  const fromBlock = opts.fromBlock ?? 0n;
  const toBlock = opts.toBlock ?? "latest";
  const event = ballastFactoryAbi.find((x: { type: string; name?: string }) => x.type === "event" && x.name === "Launched");
  const out: LaunchRecord[] = [];
  for (const factory of ALL_FACTORIES) {
    let logs;
    try {
      logs = await ctx.pub.getLogs({ address: factory, event: event as never, fromBlock, toBlock: toBlock as never });
    } catch {
      continue;
    }
    for (const log of logs) {
      const ev = decodeLaunch(log as never);
      if (!ev) continue;
      if (!opts.includeHidden && isHiddenToken(ev.token)) continue;
      out.push({
        id: ev.id, factory, token: ev.token, treasury: ev.treasury, creator: ev.creator,
        noticePeriod: ev.noticePeriod, metadataURI: ev.metadataURI,
        blockNumber: (log as { blockNumber: bigint }).blockNumber, txHash: (log as { transactionHash?: `0x${string}` }).transactionHash,
      });
    }
  }
  out.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1)); // newest first
  return out;
}

export interface BuybackStats {
  totalBurned: bigint;
  runs: bigint;
  lastBurnAt: { weth: bigint; nvda: bigint };
  spent: { weth: bigint; nvda: bigint };
  waiting: { weth: bigint; nvda: bigint };
}

/** Platform buyback/burn totals from BuybackBurnerV2. */
export async function getBuybackStats(ctx: Ctx): Promise<BuybackStats> {
  const b = ctx.addr.buybackBurnerV2;
  const call = (fn: string, args: unknown[] = []) => ctx.pub.readContract({ address: b, abi: buybackBurnerV2Abi, functionName: fn as never, args: args as never }).catch(() => 0n) as Promise<bigint>;
  const weth = ctx.addr.weth;
  const nvda = (await ctx.pub.readContract({ address: b, abi: buybackBurnerV2Abi, functionName: "nvda" }).catch(() => "0x0000000000000000000000000000000000000000")) as Address;
  const [totalBurned, runs, lastWeth, lastNvda, spentWeth, spentNvda, waitWeth, waitNvda] = await Promise.all([
    call("totalBallastBurned"), call("buybackCount"),
    call("lastBuybackAt", [weth]), call("lastBuybackAt", [nvda]),
    call("totalSpent", [weth]), call("totalSpent", [nvda]),
    call("accruedWeth"), call("accruedNvda"),
  ]);
  return {
    totalBurned, runs,
    lastBurnAt: { weth: lastWeth, nvda: lastNvda },
    spent: { weth: spentWeth, nvda: spentNvda },
    waiting: { weth: waitWeth, nvda: waitNvda },
  };
}

/** Balance of the dead address for a token (default $BALLAST v2) — cumulative burns. */
export function getDeadBalance(ctx: Ctx, token: Address = ctx.addr.ballastV2): Promise<bigint> {
  return ctx.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [ctx.addr.dead] }) as Promise<bigint>;
}
