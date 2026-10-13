import type { Address } from "viem";
import { routerV2RoutesFor } from "@/lib/routerV2";

// Stock Basket routable set — REWRITE (docs/DECISIONS.md §6, docs/BASKET_DISCOVERY.md §2).
//
// The old model keyed a single WETH/<asset> v4 PoolKey (fee/tickSpacing/hooks)
// per asset. That was wrong: no WETH/<stock> pool exists. Real liquidity is
// Fables (ETH->USDG->stock) or Ramses v3 (direct WETH, or WETH->USDG->stock),
// and the per-asset hop indices live in web/lib/routerV2.ts (the single source
// of truth, mirrored from the deployed BasketZap's fixed tables). BasketZap
// selects routes by INDEX into those fixed tables, so the frontend never
// invents an address — it only picks which fixed entries to use.
//
// This file is now just the CURATED routable allowlist: the assets whose route
// was human-verified to clear the ≤3%-impact-at-0.1-ETH bar vs Chainlink
// (docs/BASKET_DISCOVERY.md §2.2, Ramses venue, probed 2026-10-13). Same
// philosophy as before — trust comes from a verified measurement, never a
// spoofable live signal — but now it ships NON-empty.

// Lowercased asset addresses that cleared ≤3% impact at 0.1 ETH on Ramses.
// Adding one later: re-run contracts/script/probe/QuoteBasketRoutes.s.sol,
// confirm ≤3% at 0.1 ETH, add the address here.
const ROUTABLE: ReadonlySet<string> = new Set(
  [
    "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", // SGOV  (0.04%)
    "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", // AAPL  (0.18%)
    "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", // GOOGL (0.15%)
    "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", // NVDA  (0.22%)
    "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", // SPY   (0.24%)
    "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", // PLTR  (0.56%)
    "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", // CRCL  (0.99%)
  ].map((a) => a.toLowerCase()),
);

/** True if `asset` is both human-verified routable (≤3% @0.1 ETH) AND has a
 *  concrete hop-index route in the BasketZap/routerV2 tables. Both must hold —
 *  the allowlist is the quality gate, the index table is the execution path. */
export function isRoutable(asset: Address): boolean {
  return ROUTABLE.has(asset.toLowerCase()) && routerV2RoutesFor(asset) !== undefined;
}

// Suggested presets (docs/BASKET_DISCOVERY.md) — ticker lists only. The picker
// filters each against isRoutable() live, so a preset silently shrinks (or
// disables entirely) as the routable set changes, rather than this file needing
// to track which registry address is "active" per preset by hand.
export type BasketPresetId = "index" | "aiChips" | "cashLike" | "custom";

export const BASKET_PRESETS: { id: BasketPresetId; label: string; tickers: string[] }[] = [
  { id: "index", label: "Index", tickers: ["SPY"] }, // QQQ not routable at size (small-ticket only)
  { id: "aiChips", label: "AI chips", tickers: ["NVDA", "PLTR"] }, // AMD route dead
  { id: "cashLike", label: "Cash-like", tickers: ["SGOV"] },
  { id: "custom", label: "Custom", tickers: [] },
];
