// ballast-sdk — PREVIEW SDK for the Ballast launchpad on Robinhood Chain (4663).
// API is marked preview and may change. viem is a peer dependency.

export * from "./constants";
export * from "./errors";
export * from "./events";
export * from "./pool";
export * from "./validate";
export * as reads from "./reads";
export * as quotes from "./quotes";
export * as writes from "./writes";
export type { BallastConfig, Ctx } from "./client";

import { toCtx, type BallastConfig, type Ctx } from "./client";
import * as reads from "./reads";
import * as quotes from "./quotes";
import * as writes from "./writes";
import type { Address } from "viem";

/**
 * Create a Ballast client bound to your viem public (and optional wallet) client.
 * All reads/quotes work with just a publicClient; writes require a walletClient
 * with an account and always simulate before sending.
 *
 * @example
 * const ballast = createBallast({ publicClient });
 * const info = await ballast.getToken("0x…");
 */
export function createBallast(config: BallastConfig) {
  const ctx: Ctx = toCtx(config);
  return {
    ctx,
    // reads
    getToken: (token: Address, opts?: reads.GetTokenOpts) => reads.getToken(ctx, token, opts),
    getFeeRouter: (token: Address, opts?: { fromBlock?: bigint; toBlock?: bigint }) => reads.getFeeRouter(ctx, token, opts),
    listLaunches: (opts?: Parameters<typeof reads.listLaunches>[1]) => reads.listLaunches(ctx, opts),
    getBuybackStats: () => reads.getBuybackStats(ctx),
    getDeadBalance: (token?: Address) => reads.getDeadBalance(ctx, token),
    // quotes
    quoteBuy: (args: Parameters<typeof quotes.quoteBuy>[1]) => quotes.quoteBuy(ctx, args),
    quoteSell: (args: Parameters<typeof quotes.quoteSell>[1]) => quotes.quoteSell(ctx, args),
    // writes
    launch: (params: writes.LaunchParams) => writes.launch(ctx, params),
    graduate: (token: Address) => writes.graduate(ctx, token),
    buy: (p: writes.SwapParams) => writes.buy(ctx, p),
    sell: (p: writes.SwapParams) => writes.sell(ctx, p),
    scheduleSplit: (router: Address, next: reads.FeeSplit) => writes.scheduleSplit(ctx, router, next),
  };
}

export type BallastClient = ReturnType<typeof createBallast>;
