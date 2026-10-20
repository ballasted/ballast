import { decodeEventLog, type Address, type Hex } from "viem";
import type { Ctx } from "./client";
import { requireWallet } from "./client";
import {
  ballastFactoryAbi,
  feeRouterFactoryV2Abi,
  feeRouterFactoryAbi,
  feeRouterV2Abi,
} from "./constants/abis";
import { universalRouterExecuteAbi, buildV4SwapInput, swapDeadline, computeMinOut, type SwapSide } from "./pool";
import { quoteBuy, quoteSell } from "./quotes";
import { SimulationError, SplitShapeError, SplitDelayError, ValidationError } from "./errors";
import { validateFeeSplit, isInstantSplitChange, splitsEqual } from "./validate";
import type { FeeSplit } from "./reads";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

// Fixed launch params — IDENTICAL to web/hooks/useFeeRouterLaunchRunner.ts so an
// SDK launch produces the same on-chain shape as the Create page.
const ZERO_POOL_KEY = { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO } as const;
const DISCLOSURE_VERSION = "0xf6c3b5e6a6c5d6f9a6f6a5b6c5d6e6f9a6f6a5b6c5d6e6f9a6f6a5b6c5d6e6f9" as const;
const MAX_SLIPPAGE_BPS = 1000;
const MAX_ROUTE_PER_CALL = 100_000_000_000_000_000_000n;
const ROUTE_COOLDOWN_SECONDS = 3600n;

async function simulateAndSend(ctx: Ctx, params: Parameters<Ctx["pub"]["simulateContract"]>[0], label: string): Promise<{ hash: Hex; receipt: Awaited<ReturnType<Ctx["pub"]["waitForTransactionReceipt"]>> }> {
  const wallet = requireWallet(ctx);
  let request;
  try {
    ({ request } = await ctx.pub.simulateContract({ ...params, account: wallet.account } as never));
  } catch (e) {
    throw new SimulationError(`${label} would revert`, (e as Error)?.message, e);
  }
  const hash = (await wallet.writeContract(request as never)) as Hex;
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new SimulationError(`${label} reverted on-chain`, undefined, receipt);
  return { hash, receipt };
}

export interface LaunchParams {
  name: string;
  symbol: string;
  metadataURI: string;
  /** 1–3 quote assets: WETH and/or up to 2 stock tokens. */
  quoteAssets: Address[];
  /** Withdrawal notice period in seconds (immutable after launch). */
  noticePeriod: bigint;
  /** 5-bucket split in bps; must sum to 10,000. */
  split: FeeSplit;
  /** Family parent token (required if split.parentBurnBps > 0). */
  parent?: Address;
}

export interface LaunchResult {
  token: Address;
  treasury: Address;
  router: Address;
  txHash: Hex;
}

/**
 * Launch a new Ballast token through FeeRouterFactoryV2.createAndLaunch — the same
 * call the Create page makes. The split is active from block one. This performs
 * ONLY the launch (step 1); seed the pool with `graduate()` and, for a backed
 * launch, deposit into the treasury first (see depositTreasury / graduate).
 */
export async function launch(ctx: Ctx, params: LaunchParams): Promise<LaunchResult> {
  validateFeeSplit(params.split, { parent: params.parent, allowTreasury: false });
  if (params.quoteAssets.length < 1 || params.quoteAssets.length > 3) {
    throw new ValidationError("quoteAssets must have 1–3 entries (WETH and/or up to 2 stock tokens).");
  }
  const factory = ctx.addr.feeRouterFactoryV2;
  const commonArgs = [
    ctx.addr.hook, ctx.addr.weth, ctx.addr.poolManager, ZERO, ZERO_POOL_KEY, ctx.addr.assetRegistry,
    MAX_SLIPPAGE_BPS, MAX_ROUTE_PER_CALL, ROUTE_COOLDOWN_SECONDS, DISCLOSURE_VERSION, ctx.addr.factory,
    params.name, params.symbol, params.noticePeriod, params.metadataURI, params.quoteAssets,
  ] as const;
  const { receipt, hash } = await simulateAndSend(ctx, {
    address: factory, abi: feeRouterFactoryV2Abi, functionName: "createAndLaunch",
    args: [...commonArgs, params.parent ?? ZERO, params.split.creatorBps, params.split.treasuryBps, params.split.buybackBps, params.split.parentBurnBps, params.split.rewardsBps],
  } as never, "launch");

  let token: Address | undefined, treasury: Address | undefined, router: Address | undefined;
  for (const log of receipt.logs) {
    try { const p = decodeEventLog({ abi: feeRouterFactoryV2Abi, ...log }); if (p.eventName === "FeeRouterCreated") router = (p.args as { router: Address }).router; } catch { /* */ }
    try { const p = decodeEventLog({ abi: ballastFactoryAbi, ...log }); if (p.eventName === "Launched") { const a = p.args as { token: Address; treasury: Address }; token = a.token; treasury = a.treasury; } } catch { /* */ }
  }
  if (!token || !treasury || !router) throw new SimulationError("Could not read launched token/treasury/router from the receipt");
  return { token, treasury, router, txHash: hash };
}

/** Seed the pool (permissionless once the token exists). LP is locked permanently. */
export async function graduate(ctx: Ctx, token: Address): Promise<Hex> {
  const { hash } = await simulateAndSend(ctx, { address: ctx.addr.factory, abi: ballastFactoryAbi, functionName: "graduate", args: [token] } as never, "graduate");
  return hash;
}

export interface SwapParams {
  token: Address;
  /** Input amount: ETH-wei for buy, token-wei for sell. */
  amountIn: bigint;
  /** Slippage tolerance in bps (used when minOut is not given explicitly). */
  slippageBps?: number;
  /** Explicit minOut; overrides the quoted slippage calc. */
  minOut?: bigint;
  /** Deadline (unix seconds). Defaults to now + 10min from the chain clock. */
  deadline?: bigint;
  hook?: Address;
}

async function swap(ctx: Ctx, side: SwapSide, p: SwapParams): Promise<Hex> {
  const slippageBps = p.slippageBps ?? 100;
  let minOut = p.minOut;
  if (minOut === undefined) {
    const q = side === "buy"
      ? await quoteBuy(ctx, { token: p.token, ethIn: p.amountIn, slippageBps, hook: p.hook })
      : await quoteSell(ctx, { token: p.token, tokenIn: p.amountIn, slippageBps, hook: p.hook });
    minOut = computeMinOut(q.amountOut, slippageBps);
  }
  const built = buildV4SwapInput({ token: p.token, side, amountIn: p.amountIn, amountOutMinimum: minOut, hook: p.hook, weth: ctx.addr.weth });
  let deadline = p.deadline;
  if (deadline === undefined) {
    const block = await ctx.pub.getBlock();
    deadline = swapDeadline(Number(block.timestamp));
  }
  const { hash } = await simulateAndSend(ctx, {
    address: ctx.addr.universalRouter, abi: universalRouterExecuteAbi, functionName: "execute",
    args: [built.commands, built.inputs, deadline], value: built.value,
  } as never, side === "buy" ? "buy" : "sell");
  return hash;
}

/** Buy `token` with native ETH (WETH pool). Quotes minOut unless you pass one.
 *  Non-WETH-quoted pools are a documented SDK extension point (see README). */
export function buy(ctx: Ctx, p: SwapParams): Promise<Hex> {
  return swap(ctx, "buy", p);
}
/** Sell `token` for native ETH (WETH pool). */
export function sell(ctx: Ctx, p: SwapParams): Promise<Hex> {
  return swap(ctx, "sell", p);
}

export interface ScheduleSplitResult {
  hash: Hex;
  /** true = applied instantly (creator share not raised, no bucket lowered);
   *  false = scheduled with the 7-day delay. */
  instant: boolean;
}

/**
 * Change a FeeRouter v2 token's split. Mirrors the contract's asymmetric-delay
 * rule: INSTANT when the creator share is not raised and no other bucket is
 * lowered; otherwise the 7-day delay applies. Validates shape locally, then
 * simulates (which also enforces the rules on-chain) before sending.
 */
export async function scheduleSplit(ctx: Ctx, router: Address, next: FeeSplit): Promise<ScheduleSplitResult> {
  const sum = next.creatorBps + next.treasuryBps + next.buybackBps + next.parentBurnBps + next.rewardsBps;
  if (sum !== 10000) throw new SplitShapeError(`Fee split must sum to 10000 bps (got ${sum}).`);

  // Read the current split + constraints to classify instant vs delayed and to
  // give a readable error BEFORE simulate for the common misconfigurations.
  const read = (fn: string) => ctx.pub.readContract({ address: router, abi: feeRouterV2Abi, functionName: fn as never }).catch(() => undefined);
  const [cur, treasuryAsset, parent] = await Promise.all([
    Promise.all([read("creatorBps"), read("treasuryBps"), read("buybackBps"), read("parentBurnBps"), read("rewardsBps")]),
    read("treasuryAsset"), read("parent"),
  ]);
  if (next.treasuryBps > 0 && (!treasuryAsset || treasuryAsset === ZERO)) throw new SplitShapeError("treasuryBps > 0 but this router's treasury bucket is disabled (treasuryAsset = 0).");
  if (next.parentBurnBps > 0 && (!parent || parent === ZERO)) throw new ValidationError("parentBurnBps > 0 but this router has no family parent configured.");

  const [cc, ct, cb, cp, cr] = cur.map((v) => Number(v ?? 0)) as [number, number, number, number, number];
  const current: FeeSplit = { creatorBps: cc, treasuryBps: ct, buybackBps: cb, parentBurnBps: cp, rewardsBps: cr };
  const instant = isInstantSplitChange(current, next);
  if (splitsEqual(current, next)) {
    throw new SplitDelayError("The requested split equals the current split — nothing to schedule.");
  }

  const { hash } = await simulateAndSend(ctx, {
    address: router, abi: feeRouterV2Abi, functionName: "scheduleSplit",
    args: [next.creatorBps, next.treasuryBps, next.buybackBps, next.parentBurnBps, next.rewardsBps],
  } as never, "scheduleSplit");
  return { hash, instant };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension points filled by Phase 3 (RoundupRouter + BurnVote).
// These throw a clear error until the contracts are deployed and wired in.
// ─────────────────────────────────────────────────────────────────────────────

/** @preview Phase 3 — buy/sell with an optional stock round-up leg to your wallet. */
export function buyWithRoundup(_ctx: Ctx, _p: unknown): Promise<Hex> {
  throw new ValidationError("buyWithRoundup is a Phase 3 extension point — RoundupRouter is not wired into the SDK yet.");
}
/** @preview Phase 3 — burn tokens to the dead address to vote a community default stock. */
export function vote(_ctx: Ctx, _p: unknown): Promise<Hex> {
  throw new ValidationError("vote is a Phase 3 extension point — BurnVote is not wired into the SDK yet.");
}
