import type { Address } from "viem";

// Stock Basket route table — a CURATED, human-sourced list of real on-chain
// WETH/<asset> v4 pools, never a live-discovered one. Same philosophy as
// AssetRegistry itself: trust comes from a verified canonical source, never a
// spoofable live signal (CLAUDE.md's anti-impostor stance). BasketZap takes
// the full PoolKey per leg as a call parameter (contracts/src/BasketZap.sol),
// so adding a route here is a config change, never a contract redeploy.
//
// THIS TABLE SHIPS EMPTY. An exhaustive (within RPC constraints) search found
// zero on-chain WETH pools for any of the 16 AssetRegistry-listed assets as
// of 2026-10-12 — see docs/BASKET_DISCOVERY.md §2 and docs/DECISIONS.md §3
// for the full writeup of what was tried. Every preset below is empty as a
// direct result; the picker renders an honest "not routable yet" state
// rather than offering a basket that can't actually execute.
//
// To add a route once one is sourced and verified: add an entry here keyed by
// the asset's canonical AssetRegistry address (never by ticker), with the
// REAL fee/tickSpacing/hooks of the pool that was actually found and proven
// (e.g. with StateView.getSlot0 returning a nonzero sqrtPriceX96, and ideally
// a successful V4Quoter.quoteExactInputSingle at a realistic size).
export type BasketRoute = {
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export const BASKET_ROUTES: Record<string, BasketRoute> = {};

export function routeFor(asset: Address): BasketRoute | undefined {
  return BASKET_ROUTES[asset.toLowerCase()];
}

export function isRoutable(asset: Address): boolean {
  return routeFor(asset) !== undefined;
}

// Suggested presets (docs/BASKET_DISCOVERY.md §2) — ticker lists only. The
// picker filters each against isRoutable() live, so a preset silently shrinks
// (or disables entirely) as routes are added or liquidity disappears, rather
// than this file needing to track which registry address is "active" per
// preset by hand.
export type BasketPresetId = "index" | "aiChips" | "cashLike" | "custom";

export const BASKET_PRESETS: { id: BasketPresetId; label: string; tickers: string[] }[] = [
  { id: "index", label: "Index", tickers: ["SPY", "QQQ"] },
  { id: "aiChips", label: "AI chips", tickers: ["NVDA", "AMD", "PLTR"] },
  { id: "cashLike", label: "Cash-like", tickers: ["SGOV"] },
  { id: "custom", label: "Custom", tickers: [] },
];
