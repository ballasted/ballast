import type { Address } from "viem";

// Contract addresses come from env, filled after deployment. Never hardcode
// per-launch addresses — those resolve from the BallastFactory registry
// (build-spec §12, CLAUDE.md conventions).

function asAddress(v: string | undefined): Address | undefined {
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return undefined;
  return v as Address;
}

// ── Deployed by DeployMainnet.s.sol (Part 2) ─────────────────────────────────
export const LENS_ADDRESS = asAddress(process.env.NEXT_PUBLIC_LENS_ADDRESS);
export const ASSET_REGISTRY_ADDRESS = asAddress(
  process.env.NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS,
);
export const FACTORY_ADDRESS = asAddress(process.env.NEXT_PUBLIC_FACTORY_ADDRESS);
export const HOOK_ADDRESS = asAddress(process.env.NEXT_PUBLIC_V4_HOOK_ADDRESS);

// ── Pre-existing chain infrastructure (verified, docs/robinhood-chain-research) ─
export const WETH_ADDRESS = asAddress(process.env.NEXT_PUBLIC_WETH_ADDRESS);
export const POOL_MANAGER_ADDRESS = asAddress(
  process.env.NEXT_PUBLIC_POOL_MANAGER_ADDRESS,
);
export const STATE_VIEW_ADDRESS = asAddress(
  process.env.NEXT_PUBLIC_STATE_VIEW_ADDRESS,
);
export const QUOTER_ADDRESS = asAddress(process.env.NEXT_PUBLIC_V4_QUOTER_ADDRESS);
export const UNIVERSAL_ROUTER_ADDRESS = asAddress(
  process.env.NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS,
);
export const ETH_USD_FEED_ADDRESS = asAddress(
  process.env.NEXT_PUBLIC_ETH_USD_FEED_ADDRESS,
);

// Canonical Permit2 (same address on every chain). The UniversalRouter pulls
// ERC-20 inputs through Permit2, so a swap that spends WETH needs a Permit2
// allowance, not a direct router allowance.
export const PERMIT2_ADDRESS =
  "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

export const isLensConfigured = Boolean(LENS_ADDRESS);
export const isFactoryConfigured = Boolean(FACTORY_ADDRESS);
export const isRegistryConfigured = Boolean(ASSET_REGISTRY_ADDRESS);
// A swap needs the pool identity (hook + WETH) and a route (router + state view).
export const isSwapConfigured = Boolean(
  HOOK_ADDRESS &&
    WETH_ADDRESS &&
    UNIVERSAL_ROUTER_ADDRESS &&
    STATE_VIEW_ADDRESS,
);

// Fixed launch parameters, mirrored from BallastFactory so the UI can preview
// backing per token before any contract call. Read economic globals live; these
// two are compile-time constants in the factory, safe to mirror.
export const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n; // 1B, 18 decimals
export const TICK_SPACING = 60;
