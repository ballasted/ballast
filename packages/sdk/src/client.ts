import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from "viem";
import { ADDRESSES, type BallastAddresses } from "./constants/addresses";

export type PublicClientLike = PublicClient<Transport, Chain | undefined>;
export type WalletClientLike = WalletClient<Transport, Chain | undefined, Account>;

export interface BallastConfig {
  /** A viem PublicClient pointed at Robinhood Chain (4663). Required for reads. */
  publicClient: PublicClientLike;
  /** A viem WalletClient with an account. Required for writes. */
  walletClient?: WalletClientLike;
  /** Override any default contract address (e.g. a new factory after redeploy). */
  addresses?: Partial<BallastAddresses>;
}

export interface Ctx {
  pub: PublicClientLike;
  wallet?: WalletClientLike;
  addr: BallastAddresses;
}

export function toCtx(cfg: BallastConfig): Ctx {
  return {
    pub: cfg.publicClient,
    wallet: cfg.walletClient,
    addr: { ...ADDRESSES, ...(cfg.addresses ?? {}) } as BallastAddresses,
  };
}

export function requireWallet(ctx: Ctx): WalletClientLike & { account: Account } {
  if (!ctx.wallet?.account) {
    throw new Error("A walletClient with an account is required for write operations.");
  }
  return ctx.wallet as WalletClientLike & { account: Account };
}

export type { Address };
