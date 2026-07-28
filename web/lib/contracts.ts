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
// FeeConfig — the fee split shown in the create flow is read live from here, not
// hardcoded, because the owner can retune it (CLAUDE.md conventions).
export const FEE_CONFIG_ADDRESS = asAddress(
  process.env.NEXT_PUBLIC_FEE_CONFIG_ADDRESS,
);

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
export const isFeeConfigConfigured = Boolean(FEE_CONFIG_ADDRESS);

// ── Factory registry: multi-factory union ───────────────────────────────────
// The launch registry is VERSIONED. Changing factory logic (e.g. graduate()'s
// freshness gate) means deploying a NEW factory, and launches from older factories
// must NOT vanish from Discover — $BALLAST itself lives in the first factory and is
// the pinned protocol token. So READS union an ordered list of factories and WRITES
// (launch/graduate) always target the current one (FACTORY_ADDRESS).
//
// This is a config ARRAY, not a hardcoded pair, so a third factory one day needs no
// change to any read path — only the env below.
//
// Env:
//   NEXT_PUBLIC_FACTORY_ADDRESS           the CURRENT factory. Every write targets
//                                         it; it is the top (newest) of the read union.
//   NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES   comma-separated OLDER factories, listed
//                                         newest-first, read-only.
//
// Ordering matters: newest-first, so new launches sort above old and, on the rare
// token-address collision across registries, the NEWEST factory wins dedup (it is
// the live registry; see useProjects). All factories MUST share ONE AssetRegistry,
// so the allowlist is unified across versions — a redeploy reuses
// NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS untouched.
export type FactoryRef = {
  address: Address;
  // Deprecated = a prior factory kept ONLY so its existing launches stay listed. It
  // can be dropped from NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES once nothing it launched
  // needs to appear on Discover. For the first factory that means: after $BALLAST is
  // retired or migrated to a newer registry. Until then, dropping it delists $BALLAST.
  deprecated: boolean;
};

function parseAddressList(v: string | undefined): Address[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => asAddress(s.trim()))
    .filter((a): a is Address => Boolean(a));
}

const PRIOR_FACTORY_ADDRESSES = parseAddressList(
  process.env.NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES,
);

// Ordered newest-first: the current factory, then priors in the order given.
export const FACTORIES: FactoryRef[] = [
  ...(FACTORY_ADDRESS ? [{ address: FACTORY_ADDRESS, deprecated: false }] : []),
  ...PRIOR_FACTORY_ADDRESSES.map((address) => ({ address, deprecated: true })),
];

// Just the addresses, newest-first — what the read hooks/servers enumerate.
export const FACTORY_ADDRESSES: Address[] = FACTORIES.map((f) => f.address);

// Core addresses the app cannot function without. `asAddress` already maps a
// missing OR zero/malformed value to `undefined`, so this list catches both the
// unset and the `0x0` case the spec calls out — a startup guard surfaces it as a
// clear configuration error rather than letting a write revert confusingly later.
export const REQUIRED_CONTRACTS = [
  ["Factory", "NEXT_PUBLIC_FACTORY_ADDRESS", FACTORY_ADDRESS],
  ["Backing lens", "NEXT_PUBLIC_LENS_ADDRESS", LENS_ADDRESS],
  ["Asset registry", "NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS", ASSET_REGISTRY_ADDRESS],
] as const;

export const missingContracts: string[] = REQUIRED_CONTRACTS.filter(
  ([, , addr]) => !addr,
).map(([name, envVar]) => `${name} (${envVar})`);

export const hasConfigError = missingContracts.length > 0;
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
