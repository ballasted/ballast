import { defineChain, type Chain } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// CHAIN PROFILE — the single switch that makes this ONE codebase ship as TWO
// independent apps (two Vercel projects / two domains), selected at build time by
// NEXT_PUBLIC_CHAIN:
//
//   NEXT_PUBLIC_CHAIN unset | "robinhood"  → Robinhood Chain 4663, gen-4 (default,
//                                            the existing app, unchanged behaviour)
//   NEXT_PUBLIC_CHAIN="elysium"            → Elysium 99901, gen-5 ("Gen 5 · beta")
//
// Everything chain-specific (chain id, RPC, explorer, native/quote symbol, which
// product surfaces exist, which swap encoding to use) lives HERE so the rest of the
// app reads `profile`/`activeChain` and never hardcodes a chain again. The contract
// ADDRESSES are already env-driven (lib/contracts.ts), so the Elysium deployment is
// the same build with a different NEXT_PUBLIC_CHAIN + a different set of
// NEXT_PUBLIC_*_ADDRESS values.
//
// IMPORTANT (Elysium): users must send through a DIRECT Elysium RPC, never the
// HyperEVM "inbox". The direct RPC is what wallet_addEthereumChain hands the wallet.
// ─────────────────────────────────────────────────────────────────────────────

export type ChainKey = "robinhood" | "elysium";

export const CHAIN_KEY: ChainKey =
  process.env.NEXT_PUBLIC_CHAIN === "elysium" ? "elysium" : "robinhood";

// Public RPCs. Both are intentionally overridable with NEXT_PUBLIC_RPC_URL so a
// deployment can point the wallet-facing/add-chain URL at a dedicated endpoint.
// For Elysium the primary is Kinetiq's direct RPC; elyscan is the documented backup.
const ROBINHOOD_PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const ELYSIUM_PRIMARY_RPC = "https://rpc.elysium.kinetiq.xyz";
const ELYSIUM_BACKUP_RPC = "https://rpc.elyscan.live";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD_PUBLIC_RPC] },
    public: { http: [ROBINHOOD_PUBLIC_RPC] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: { multicall3: { address: MULTICALL3 } },
});

// Elysium — Kinetiq's Arbitrum-Orbit L2 settling to HyperEVM, gas token HYPE.
// Home of BALLAST gen-5. NOTE: inside the EVM `block.number` returns the PARENT
// chain block, so all time logic must use `block.timestamp` (gen-5 contracts do).
export const elysiumChain = defineChain({
  id: 99901,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: {
    // Primary first, backup second — a wallet that imports this gets both, and the
    // app's own fallback transport tries them in order.
    default: { http: [ELYSIUM_PRIMARY_RPC, ELYSIUM_BACKUP_RPC] },
    public: { http: [ELYSIUM_PRIMARY_RPC, ELYSIUM_BACKUP_RPC] },
  },
  blockExplorers: {
    default: { name: "Elyscan", url: "https://elyscan.live" },
  },
  contracts: { multicall3: { address: MULTICALL3 } },
});

export type ChainFeatures = {
  /** ProjectTreasury + backing-per-token disclosure (gen-4 only). */
  treasury: boolean;
  backing: boolean;
  /** AssetRegistry-gated green quote assets (gen-4). Gen-5 greenlist is in the factory. */
  assetRegistry: boolean;
  /** Multi-quote pay-with-native routing over Fables/Ramses (Robinhood only). */
  routerV2: boolean;
  ramses: boolean;
  basket: boolean;
  roundup: boolean;
  /** On-chain range-order limit orders via the hook (gen-5). */
  limitOrders: boolean;
};

export type ChainProfile = {
  key: ChainKey;
  /** BALLAST contract generation this chain runs. */
  generation: 4 | 5;
  /** Beta/label tag shown in the UI. Empty on Robinhood. */
  label: string;
  chain: Chain;
  /** The absolute, wallet-reachable RPC (addEthereumChain + client fallback). */
  publicRpcUrl: string;
  backupRpcUrl?: string;
  /** Native gas symbol (ETH / HYPE). */
  nativeSymbol: string;
  /** Wrapped-native quote symbol (WETH / WHYPE). */
  quoteSymbol: string;
  explorerUrl: string;
  caipNetworkId: `eip155:${number}`;
  /** Which v4 UniversalRouter calldata to build. BOTH chains currently use the
   *  minHopPriceX36 fork struct — Elysium's router was empirically shown to require
   *  it too (standard v4 calldata reverts). Kept as a tagged field so a genuinely
   *  standard-v4 chain could be added later without guessing. */
  swapEncoding: "robinhood-fork";
  features: ChainFeatures;
  /** Link to the OTHER Ballast app, so users can switch chains/apps. */
  crossApp: { href: string; label: string };
};

// Cross-app links. Overridable per deployment; defaults assume the suggested
// elysium.ballasted.fun subdomain for the gen-5 app and www.ballasted.fun for gen-4.
const ROBINHOOD_APP_URL =
  process.env.NEXT_PUBLIC_ROBINHOOD_APP_URL || "https://www.ballasted.fun";
const ELYSIUM_APP_URL =
  process.env.NEXT_PUBLIC_ELYSIUM_APP_URL || "https://elysium.ballasted.fun";

const ROBINHOOD_PROFILE: ChainProfile = {
  key: "robinhood",
  generation: 4,
  label: "",
  chain: robinhoodChain,
  publicRpcUrl: process.env.NEXT_PUBLIC_RPC_URL || ROBINHOOD_PUBLIC_RPC,
  nativeSymbol: "ETH",
  quoteSymbol: "WETH",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  caipNetworkId: "eip155:4663",
  swapEncoding: "robinhood-fork",
  features: {
    treasury: true,
    backing: true,
    assetRegistry: true,
    routerV2: true,
    ramses: true,
    basket: true,
    roundup: true,
    limitOrders: false,
  },
  crossApp: { href: ELYSIUM_APP_URL, label: "Elysium · Gen 5 beta" },
};

const ELYSIUM_PROFILE: ChainProfile = {
  key: "elysium",
  generation: 5,
  label: "Gen 5 · beta",
  chain: elysiumChain,
  publicRpcUrl: process.env.NEXT_PUBLIC_RPC_URL || ELYSIUM_PRIMARY_RPC,
  backupRpcUrl: ELYSIUM_BACKUP_RPC,
  nativeSymbol: "HYPE",
  quoteSymbol: "WHYPE",
  explorerUrl: "https://elyscan.live",
  caipNetworkId: "eip155:99901",
  // EMPIRICAL (verified on an anvil fork of 99901, 2026-11-09): BOTH deployed
  // UniversalRouters on Elysium (0x1B341FDD "v2.2.0" and 0xA13f7611 "v2.1.2") REQUIRE
  // the minHopPriceX36 fork field — standard Uniswap v4 calldata REVERTS with empty
  // data inside unlockCallback, the fork calldata succeeds. So Elysium's router is the
  // SAME modified fork as Robinhood Chain, NOT stock Uniswap v4. This contradicts the
  // deployment note / task premise ("standard v4, not the minHopPriceX36 fork"); the
  // on-chain behaviour is authoritative (using standard encoding would brick every
  // swap). See web/scripts/elysiumEncDebug.mts for the reproduction.
  swapEncoding: "robinhood-fork",
  features: {
    treasury: false,
    backing: false,
    assetRegistry: false,
    routerV2: false,
    ramses: false,
    basket: false,
    roundup: false,
    limitOrders: true,
  },
  crossApp: { href: ROBINHOOD_APP_URL, label: "Robinhood Chain" },
};

const PROFILES: Record<ChainKey, ChainProfile> = {
  robinhood: ROBINHOOD_PROFILE,
  elysium: ELYSIUM_PROFILE,
};

/** The active chain profile for THIS build, selected by NEXT_PUBLIC_CHAIN. */
export const profile: ChainProfile = PROFILES[CHAIN_KEY];

/** The active viem chain. Everything in the app imports THIS, never a literal.
 *  Selected via a direct ternary (not profile.chain) so the concrete inferred type
 *  is preserved — `blockExplorers.default.url` stays non-optional for the ~20 call
 *  sites that build explorer links from it. */
export const activeChain = CHAIN_KEY === "elysium" ? elysiumChain : robinhoodChain;

export const isElysium = profile.key === "elysium";
export const isRobinhood = profile.key === "robinhood";
