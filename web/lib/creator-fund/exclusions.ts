// ─────────────────────────────────────────────────────────────────────────────
// Creator Fund — the holder-exclusion address set.
//
// A "holder" for the campaign is a real external holder. We exclude every system /
// protocol address that can carry a token balance for mechanical reasons. Sources:
//   • Static protocol addresses — the Safe, the compromised deployer EOA, Permit2,
//     the pool manager, routers, fee-router factories, buyback burners, basket zap,
//     the Ramses locker, per-generation seeders + platform vaults, factories + hooks.
//     These are deployment facts (docs/BALLAST_STATE.md + SDK addresses), mirrored
//     here with env overrides so a redeploy needs no code change.
//   • Per-token dynamic — the token's own treasury, its creator wallet, and (when
//     resolvable) its fee router + team-split recipients.
//   • Zero / dead address.
//
// Everything is lowercased. Env is read at CALL time (not import), so a script that
// loads .env before importing this module still sees the overrides.
// ─────────────────────────────────────────────────────────────────────────────
import type { Address } from "viem";

const lc = (a: string): string => a.toLowerCase();
const isAddr = (v: string | undefined): v is string => !!v && /^0x[0-9a-fA-F]{40}$/.test(v);

// Deployment-fact constants (newest-first per generation). Mirrored from
// docs/BALLAST_STATE.md, packages/sdk/src/constants/addresses.ts, and
// web/lib/contracts.ts. Env overrides below extend/replace per key.
const KNOWN_SYSTEM_ADDRESSES: string[] = [
  "0x000000000000000000000000000000000000dEaD", // dead/burn
  "0xEFC97e16a24d2434C7138a2634E554a0631aC079", // protocol Safe
  "0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1", // compromised deployer EOA
  "0x000000000022D473030F116dDEE9F6B43aC78BA3", // Permit2
  "0x8366a39CC670B4001A1121B8F6A443A643e40951", // PoolManager
  "0x8876789976dEcBfCbBbe364623C63652db8C0904", // UniversalRouter
  "0xa0Aba92d3D99eC905BcFc8a6aCfC889468a747E0", // BallastRouterV2
  "0xc422e0a6ca75d1ffAfd77f72b710b2Ef3aeF50e1", // BallastRouter v1
  "0x939536F25b72ca261076Fa485D2A0EE647e54818", // FeeRouterFactory v1
  "0x5d3250C7ac29648cB54dEbBB89DaD6e733eec5D3", // FeeRouterFactory v2
  "0xDA9ef87A6146f435d34237a9B3a81689603Fa503", // BuybackBurnerV2
  "0x36198DaeFDCeF476cF8e77b0961A4D79aE7852Be", // BuybackBurner (gen2/3) = platform vault gen2/3
  "0x3b4f9a424aeca0F3275981d5eAd349c62ec9BD85", // platform vault gen1
  "0x87c046aB0fB8B7B86BA1a62A956242d499051aBA", // BasketZap
  "0xF6CD2e03259150D4FF745CDd620c09FBF30DE1dC", // Ramses locker (external)
  "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH
  // Per-generation BallastSeeder singletons (LP position owners).
  "0x690241daf35efdf34e0b726aceb451bd901858db", // gen-4 seeder
  "0xFC5362e535a20c99D75C2595dfF6f7bA1E99A523", // gen-3 seeder
  "0x7830E1F67598e8c76ce1fFf79b1D2A3E915325E4", // gen-2 seeder
  "0xbe043844e0B7713B4c7841DCCB3C4e1c6eA5eCF9", // gen-1 seeder
  // Factories + hooks (don't normally hold the token; included defensively).
  "0xa32b9870A1B77544Eb4e044Cae9f3e62A1F71f67", // gen-4 factory
  "0x3eb5532e982931cad40d0416adbd7930a57965ae", // gen-3 factory
  "0x05aaa5c50e8c3067c3321df07686ac52be8f2ed1", // gen-2 factory
  "0x069974136c78Cf0F2162463B95321E59F56523D8", // gen-1 factory
  "0x4eB2dD759F4d6524E66057D1ADc10c26E40142Cc", // gen-4 hook
  "0x4915f612c89100bEbE9279355fab27022D0940cc", // gen-3 hook
  "0x743102aa1De955b5F0Fada1377B6E545Fdb080cc", // gen-2 hook
  "0x9C15c992E4De3711715C8B7D717EF46e474680CC", // gen-1 hook
];

/** Static protocol/system addresses, lowercased, including any env overrides. */
export function systemAddresses(): Set<string> {
  const out = new Set<string>(KNOWN_SYSTEM_ADDRESSES.map(lc));
  const envKeys = [
    "NEXT_PUBLIC_POOL_MANAGER_ADDRESS",
    "NEXT_PUBLIC_UNIVERSAL_ROUTER_ADDRESS",
    "NEXT_PUBLIC_ROUTER_V2_ADDRESS",
    "NEXT_PUBLIC_ROUTER_ADDRESS",
    "NEXT_PUBLIC_FEE_ROUTER_FACTORY_ADDRESS",
    "NEXT_PUBLIC_FEE_ROUTER_FACTORY_V2_ADDRESS",
    "NEXT_PUBLIC_BUYBACK_V2_ADDRESS",
    "NEXT_PUBLIC_BUYBACK_ADDRESS",
    "NEXT_PUBLIC_BASKET_ZAP_ADDRESS",
    "NEXT_PUBLIC_RAMSES_LOCKER_ADDRESS",
    "NEXT_PUBLIC_WETH_ADDRESS",
    "PROTOCOL_OWNER_ADDRESS",
    "PROTOCOL_VAULT_ADDRESS",
    "NEXT_PUBLIC_FACTORY_ADDRESS",
    "NEXT_PUBLIC_V4_HOOK_ADDRESS",
  ];
  for (const k of envKeys) {
    const v = process.env[k];
    if (isAddr(v)) out.add(lc(v));
  }
  // Comma lists.
  for (const k of ["NEXT_PUBLIC_PRIOR_FACTORY_ADDRESSES"]) {
    const v = process.env[k];
    if (v) for (const part of v.split(",")) if (isAddr(part.trim())) out.add(lc(part.trim()));
  }
  return out;
}

/** The full holder-exclusion set for ONE token: system + its treasury/creator/router/team. */
export function buildHolderExclusions(perToken: {
  creator: Address;
  treasury: Address;
  feeRouter?: Address;
  teamRecipients?: Iterable<Address>;
  extra?: Iterable<Address>;
}): Set<string> {
  const out = systemAddresses();
  out.add(lc(perToken.creator));
  out.add(lc(perToken.treasury));
  if (perToken.feeRouter) out.add(lc(perToken.feeRouter));
  for (const r of perToken.teamRecipients ?? []) out.add(lc(r));
  for (const e of perToken.extra ?? []) out.add(lc(e));
  return out;
}
