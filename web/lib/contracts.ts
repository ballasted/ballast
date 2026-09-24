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
// MetadataDenylist — owner-managed, default-allow display takedown for impersonation
// metadata. Unset = nothing is ever suppressed (default-allow), so a missing address
// degrades to the permissive state, never to hiding tokens.
export const METADATA_DENYLIST_ADDRESS = asAddress(
  process.env.NEXT_PUBLIC_METADATA_DENYLIST_ADDRESS,
);
// BuybackBurner — the /app/buyback page reads its live state + BuybackBurned events.
// Unset = the page renders an honest "not live yet" state (nothing to read).
export const BUYBACK_ADDRESS = asAddress(process.env.NEXT_PUBLIC_BUYBACK_ADDRESS);
export const isBuybackConfigured = Boolean(BUYBACK_ADDRESS);

// BallastManatee — the standalone 1,000-piece on-chain NFT mint (/app/mint). A
// separate product: no protocol contract is touched. Unset = the mint page shows
// an honest "not live yet" state. The art is computed on-chain by an immutable
// renderer the NFT points at, so only the collection address is needed here.
export const MANATEE_ADDRESS = asAddress(process.env.NEXT_PUBLIC_MANATEE_ADDRESS);
export const isManateeConfigured = Boolean(MANATEE_ADDRESS);

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
export const isDenylistConfigured = Boolean(METADATA_DENYLIST_ADDRESS);

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

// ── Hook registry: multi-hook union (same shape/reason as the factory union) ──
// The BallastHook is baked into every pool's PoolKey at graduation and is IMMUTABLE
// there. Redeploying the hook (a new singleton) does NOT move existing pools — their
// fees keep accruing to the OLD hook's `owed` mapping, and their poolId is still
// computed with the OLD hook. So, exactly like factories:
//   • WRITES / new pools use the CURRENT hook (HOOK_ADDRESS).
//   • Fee claims read `owed(me)` across EVERY hook and claim from each with a balance.
//   • Pool price / swap routing resolve WHICH hook a given token's pool lives under
//     (newest-first), so prior-hook tokens ($BALLAST, CHRS) stay priced and tradeable.
//
// Checked-in history — see docs/seeded-hook-history.md, kept in sync manually on
// every hook redeploy. This is the SOURCE OF TRUTH for prior generations' hooks,
// not env: the previous design zipped NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES and
// NEXT_PUBLIC_PRIOR_HOOK_ADDRESSES together BY INDEX, two independently-edited env
// lists — one short entry silently made an entire generation's real, liquid pools
// invisible with no error (BALLAST/CHRS/RCN, found + fixed 2026-09-25). A reviewed,
// checked-in constant can't drift out of sync the same way an env var can.
const HISTORICAL_HOOKS: { factory: Address; hook: Address }[] = [
  { factory: "0x069974136c78Cf0F2162463B95321E59F56523D8", hook: "0x9C15c992E4De3711715C8B7D717EF46e474680CC" },
  { factory: "0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1", hook: "0x743102aa1De955b5F0Fada1377B6E545Fdb080cc" },
];

// Ordered newest-first: current hook, then every historical one. Every hook-aware
// fallback (candidatePoolKeys) enumerates this when a factory→hook pairing is
// missing, so a config slip degrades to "probe everything" rather than finding
// nothing at all.
export const HOOK_ADDRESSES: Address[] = [
  ...(HOOK_ADDRESS ? [HOOK_ADDRESS] : []),
  ...HISTORICAL_HOOKS.map((h) => h.hook),
];

// Factory↔hook pairing. A token's pool uses the hook of the factory that launched it
// (1:1, fixed at graduation). Once a token's factory is known — from enumeration
// (useProjects) or launchIdOf (useBacking) — we probe EXACTLY ONE pool instead of
// every hook, removing the per-token × N_hooks blow-up on the Discover board.
export const FACTORY_HOOK_PAIRS: { factory: Address; hook: Address }[] = [
  ...(FACTORY_ADDRESS && HOOK_ADDRESS ? [{ factory: FACTORY_ADDRESS, hook: HOOK_ADDRESS }] : []),
  ...HISTORICAL_HOOKS,
];

const loggedMissingHookFactories = new Set<string>();

/**
 * The hook a token's pool lives under, from the factory that launched it. Reads
 * fall back to probing every hook in HOOK_ADDRESSES when this returns undefined
 * for a KNOWN prior factory, so a config slip degrades, never silently breaks —
 * but it also logs loudly (once per factory per session) so the gap is visible in
 * the console instead of just rendering "—" with no explanation.
 */
export function hookForFactory(factory: Address | undefined): Address | undefined {
  if (!factory) return undefined;
  const found = FACTORY_HOOK_PAIRS.find((p) => p.factory.toLowerCase() === factory.toLowerCase())?.hook;
  if (!found && PRIOR_FACTORY_ADDRESSES.some((f) => f.toLowerCase() === factory.toLowerCase())) {
    const key = factory.toLowerCase();
    if (!loggedMissingHookFactories.has(key)) {
      loggedMissingHookFactories.add(key);
      console.error(
        `[contracts] No hook mapped for known prior factory ${factory} — its pools cannot resolve directly ` +
          `(falling back to probing every hook in HOOK_ADDRESSES). Add it to HISTORICAL_HOOKS in lib/contracts.ts ` +
          `and docs/seeded-hook-history.md — read it live via \`cast call ${factory} "seeder()(address)"\` and the ` +
          `factory's own launch/graduate transactions if the hook itself isn't already known.`,
      );
    }
  }
  return found;
}

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
