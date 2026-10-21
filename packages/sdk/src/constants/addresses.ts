import type { Address } from "viem";

// Canonical Ballast + chain contract addresses on Robinhood Chain (4663).
// Verified from the repo's deploy docs (docs/BALLAST_STATE.md, RUNBOOK.md,
// FEE_ROUTER_DEPLOY.md, BASKET_DEPLOY.md) and lib/contracts.ts. All lowercased
// for stable comparison; viem accepts them anywhere an Address is expected.
//
// These are the LIVE defaults. Per-launch addresses (token/treasury/pool/
// feeRouter) are NEVER hardcoded — resolve them from factory reads/events
// (see reads.ts).

export const ADDRESSES = {
  // ── Core (gen-4, current) ──
  factory: "0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67",
  hook: "0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc",
  backingLens: "0x73Ac3574c8743553f41C6E25F92A145b5c0e7240",
  assetRegistry: "0x427764d0d19aB765c35A41A5aa4771580307dA81",
  feeConfig: "0xE09F093595045E8765F420Cb12E0AA250910E5AD", // gen-4 FeeConfig (80/20/0)

  // ── Fee routing ──
  feeRouterFactory: "0x939536F25b72ca261076Fa485D2A0EE647e54818", // v1
  feeRouterFactoryV2: "0x5d3250C7ac29648cB54dEbBB89DaD6e733eec5D3", // v2

  // ── Treasury / baskets / buyback ──
  basketZap: "0x87c046aB0fB8B7B86BA1a62A956242d499051aBA",
  buybackBurnerV2: "0xDA9ef87A6146f435d34237a9B3a81689603Fa503",

  // ── Tokens / addresses of note ──
  ballastV2: "0xDc605041F02e41CbD8FDC347023e93C4c3fA243C",
  safe: "0xEFC97e16a24d2434C7138a2634E554a0631aC079",
  dead: "0x000000000000000000000000000000000000dEaD",

  // ── Chain infrastructure (verified, docs/robinhood-chain-research) ──
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
  v4Quoter: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
  universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
  routerV2: "0xa0Aba92d3D99eC905BcFc8a6aCfC889468a747E0", // BallastRouterV2 (ETH→non-WETH-quoted)
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  ethUsdFeed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, Address>;

export type BallastAddresses = typeof ADDRESSES;
export type BallastAddressKey = keyof BallastAddresses;

// Prior factory generations — launches from these must still resolve. Newest-first.
// (From lib/contracts.ts FACTORY_FEE_CONFIGS; the current factory is ADDRESSES.factory.)
export const PRIOR_FACTORIES: Address[] = [
  "0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1",
  "0x069974136c78Cf0F2162463B95321E59F56523D8",
  "0x3eb5532e982931cad40d0416adbd7930a57965ae",
];

/** Every factory to scan on reads (current + prior), newest-first. */
export const ALL_FACTORIES: Address[] = [ADDRESSES.factory, ...PRIOR_FACTORIES];

/** Extra (prior-gen) hooks whose pools/fees still need reading, if any. */
export const PRIOR_HOOKS: Address[] = [];
