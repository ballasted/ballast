import type { Address } from "viem";

// Mirrors contracts/script/DeployBallastRouterV2.s.sol EXACTLY — same fixed
// hop tables the deployed BallastRouterV2 was constructed with. The frontend
// builds `fablesHopIdx`/`ramsesHopIdx` from THESE tables (never invents an
// address), because the contract validates every hop against its own
// construction-time-fixed arrays regardless of what the caller sends — a
// wrong index here just fails to chain (BadHopChain), it can't reach an
// unintended pool.
//
// Keyed by quote-asset ADDRESS, never by ticker string (CLAUDE.md: never
// resolve a quote asset from a symbol string — the impostor-ticker risk is
// real on this chain, see docs/exit-liquidity-table.md).

export type FablesHop = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type RamsesRoute = {
  pool: Address;
  tokenA: Address;
  tokenB: Address;
  // Quoting-only (the on-chain swap() call targets `pool` directly and needs
  // no tickSpacing) — Ramses's QuoterV2 looks pools up by
  // (tokenIn, tokenOut, tickSpacing), so quoting needs it even though
  // execution doesn't.
  tickSpacing: number;
};

const ETH = "0x0000000000000000000000000000000000000000" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;
const GOOGL = "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3" as Address;
const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" as Address;
const MSFT = "0xe93237C50D904957Cf27E7B1133b510C669c2e74" as Address;
const AMZN = "0x12f190a9F9d7D37a250758b26824B97CE941bF54" as Address;
const META = "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35" as Address;
const SPY = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C" as Address;
const QQQ = "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68" as Address;
const AMD = "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC" as Address;
const COIN = "0x6330D8C3178a418788dF01a47479c0ce7CCF450b" as Address;
const PLTR = "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A" as Address;
const ORCL = "0xb0992820E760d836549ba69BC7598b4af75dEE03" as Address;
const MSTR = "0xec262a75e413fAfD0dF80480274532C79D42da09" as Address;
const CRCL = "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5" as Address;
const SGOV = "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5" as Address;

const DYNAMIC_FEE = 0x800000;

// Index 0..11, exactly DeployBallastRouterV2.buildFablesHops().
export const FABLES_HOPS: FablesHop[] = [
  { currency0: ETH, currency1: USDG, fee: DYNAMIC_FEE, tickSpacing: 10, hooks: "0x06a889870C8f83640D6816319f72e2aA579b6080" as Address },
  { currency0: USDG, currency1: NVDA, fee: DYNAMIC_FEE, tickSpacing: 10, hooks: "0x66622f77B797D506e5376F7798b67ab288966080" as Address },
  { currency0: USDG, currency1: AAPL, fee: DYNAMIC_FEE, tickSpacing: 10, hooks: "0x70a9A88402989226847Ec122043CE5e7FF462080" as Address },
  { currency0: USDG, currency1: META, fee: DYNAMIC_FEE, tickSpacing: 10, hooks: "0x8AF95932eC4484fb10C641a4cBcf19a798cB2080" as Address },
  { currency0: TSLA, currency1: USDG, fee: DYNAMIC_FEE, tickSpacing: 10, hooks: "0x67D86050d22D574Df046F3D90F722045F714e080" as Address },
  { currency0: AMZN, currency1: USDG, fee: DYNAMIC_FEE, tickSpacing: 60, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" as Address },
  { currency0: USDG, currency1: CRCL, fee: DYNAMIC_FEE, tickSpacing: 60, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" as Address },
  { currency0: USDG, currency1: MSTR, fee: DYNAMIC_FEE, tickSpacing: 60, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" as Address },
  { currency0: USDG, currency1: COIN, fee: DYNAMIC_FEE, tickSpacing: 60, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" as Address },
  { currency0: USDG, currency1: PLTR, fee: DYNAMIC_FEE, tickSpacing: 60, hooks: "0x5Eb87F69bE00Df39981622Fd60A8De4b7837e080" as Address },
  { currency0: SPY, currency1: USDG, fee: DYNAMIC_FEE, tickSpacing: 10, hooks: "0xA0E8fBFf13E24Af2b5e61A72800E08a161bDe080" as Address },
  { currency0: SPY, currency1: QQQ, fee: DYNAMIC_FEE, tickSpacing: 1, hooks: "0x08E52564Bad99E05a694b4809F397edcA417A080" as Address },
];

// Index 0..16, exactly DeployBallastRouterV2.buildRamsesRoutes().
export const RAMSES_ROUTES: RamsesRoute[] = [
  { pool: "0xF8996E22ac7A67fAe741830Ad83B3b4D5e5de203" as Address, tokenA: WETH, tokenB: NVDA, tickSpacing: 50 },
  { pool: "0x3e1afDe90341F843c941fF4077d915bDE3008c7E" as Address, tokenA: WETH, tokenB: SPY, tickSpacing: 1 },
  { pool: "0xb8b1b1B0F08092faB7290476ed8BAdeD0Ca81081" as Address, tokenA: WETH, tokenB: META, tickSpacing: 50 },
  { pool: "0x741Ad272cA4fc8D3cB3B08202be4C00D0286D91E" as Address, tokenA: WETH, tokenB: QQQ, tickSpacing: 10 },
  { pool: "0xFAE65eAa11943f45E83D5B45DC7A7C801C51bfB0" as Address, tokenA: WETH, tokenB: USDG, tickSpacing: 1 },
  { pool: "0x6f7368F0dd18a4E1db631095363d109E6aDe9293" as Address, tokenA: USDG, tokenB: AAPL, tickSpacing: 1 },
  { pool: "0x131CC5ca8bAf2fc7e3A4EDC0B82e62d3E74E24dd" as Address, tokenA: USDG, tokenB: TSLA, tickSpacing: 1 },
  { pool: "0x5Ca0291DDB0Ca66a65f4269102fe4A5c9Fa8E0De" as Address, tokenA: USDG, tokenB: AMZN, tickSpacing: 1 },
  { pool: "0xe9B6F324A7019B1f073AfF1870d664Bf9673f782" as Address, tokenA: USDG, tokenB: COIN, tickSpacing: 50 },
  { pool: "0x53D3F8B79Eea3C4dD7dF5c1d3A7215BaaAd772Ee" as Address, tokenA: USDG, tokenB: PLTR, tickSpacing: 50 },
  { pool: "0x8Bab57c03aB91Bd4BDF954Feeb80078a2A439eb6" as Address, tokenA: USDG, tokenB: MSTR, tickSpacing: 10 },
  { pool: "0x9176c773fc386c94AeD7B50EDE68CF992eE143d9" as Address, tokenA: USDG, tokenB: CRCL, tickSpacing: 50 },
  { pool: "0x8695820E01903c83CCfc27a0933c9Fd69f13caC1" as Address, tokenA: USDG, tokenB: SGOV, tickSpacing: 1 },
  { pool: "0x5c0EAa89799F7B76606f4Ff66C92a2654d178927" as Address, tokenA: USDG, tokenB: GOOGL, tickSpacing: 1 },
  { pool: "0x8595C466E148ECC019183fA771c9670792143DE7" as Address, tokenA: USDG, tokenB: MSFT, tickSpacing: 50 },
  { pool: "0x16dd3a82ea5B132Be4fcF4dAD4Cc7eCD4eb25C3F" as Address, tokenA: USDG, tokenB: AMD, tickSpacing: 50 },
  { pool: "0x06DB17c4Ec4Ab4Ecc856110BBa1cF02AF7FE6Bf8" as Address, tokenA: USDG, tokenB: ORCL, tickSpacing: 5 },
];

type Routes = { fablesHopIdx: number[]; ramsesHopIdx: number[] };

// Per quote-asset ADDRESS (lowercased). fablesHopIdx empty = no Fables route
// for this asset (SGOV/GOOGL/MSFT/AMD/ORCL) — Ramses-only.
const ROUTES_BY_QUOTE_ASSET: Record<string, Routes> = {
  [NVDA.toLowerCase()]: { fablesHopIdx: [0, 1], ramsesHopIdx: [0] },
  [AAPL.toLowerCase()]: { fablesHopIdx: [0, 2], ramsesHopIdx: [4, 5] },
  [META.toLowerCase()]: { fablesHopIdx: [0, 3], ramsesHopIdx: [2] },
  [TSLA.toLowerCase()]: { fablesHopIdx: [0, 4], ramsesHopIdx: [4, 6] },
  [AMZN.toLowerCase()]: { fablesHopIdx: [0, 5], ramsesHopIdx: [4, 7] },
  [CRCL.toLowerCase()]: { fablesHopIdx: [0, 6], ramsesHopIdx: [4, 11] },
  [MSTR.toLowerCase()]: { fablesHopIdx: [0, 7], ramsesHopIdx: [4, 10] },
  [COIN.toLowerCase()]: { fablesHopIdx: [0, 8], ramsesHopIdx: [4, 8] },
  [PLTR.toLowerCase()]: { fablesHopIdx: [0, 9], ramsesHopIdx: [4, 9] },
  [SPY.toLowerCase()]: { fablesHopIdx: [0, 10], ramsesHopIdx: [1] },
  [QQQ.toLowerCase()]: { fablesHopIdx: [0, 10, 11], ramsesHopIdx: [3] },
  [SGOV.toLowerCase()]: { fablesHopIdx: [], ramsesHopIdx: [4, 12] },
  [GOOGL.toLowerCase()]: { fablesHopIdx: [], ramsesHopIdx: [4, 13] },
  [MSFT.toLowerCase()]: { fablesHopIdx: [], ramsesHopIdx: [4, 14] },
  [AMD.toLowerCase()]: { fablesHopIdx: [], ramsesHopIdx: [4, 15] },
  [ORCL.toLowerCase()]: { fablesHopIdx: [], ramsesHopIdx: [4, 16] },
};

/** Buy-direction (ETH -> ... -> quoteAsset) hop indices for this quote asset, or
 *  undefined if BallastRouterV2 has no route at all for it. */
export function routerV2RoutesFor(quoteAsset: Address): Routes | undefined {
  return ROUTES_BY_QUOTE_ASSET[quoteAsset.toLowerCase()];
}

export function fablesHopsForIdx(idx: number[]): FablesHop[] {
  return idx.map((i) => {
    const hop = FABLES_HOPS[i];
    if (!hop) throw new Error(`invalid Fables hop index ${i}`);
    return hop;
  });
}

export function ramsesRoutesForIdx(idx: number[]): RamsesRoute[] {
  return idx.map((i) => {
    const route = RAMSES_ROUTES[i];
    if (!route) throw new Error(`invalid Ramses route index ${i}`);
    return route;
  });
}

export { ETH as NATIVE_ETH_SENTINEL, USDG as USDG_TOKEN, WETH as WETH_TOKEN };

export type PathKeyTuple = {
  intermediateCurrency: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  hookData: `0x${string}`;
};

/** Mirrors BallastRouterV2._buildFablesPath exactly: walks `hops` in order,
 *  tracking the running currency, for the v4Quoter multi-hop ABI. Throws if a
 *  hop doesn't connect — same failure shape as the contract (BadHopChain). */
export function buildFablesPathKeys(hops: FablesHop[], entryCurrency: Address): PathKeyTuple[] {
  let cur = entryCurrency.toLowerCase();
  return hops.map((h) => {
    const c0 = h.currency0.toLowerCase();
    const c1 = h.currency1.toLowerCase();
    let next: Address;
    if (cur === c0) next = h.currency1;
    else if (cur === c1) next = h.currency0;
    else throw new Error("Fables hop chain does not connect");
    cur = next.toLowerCase();
    return { intermediateCurrency: next, fee: h.fee, tickSpacing: h.tickSpacing, hooks: h.hooks, hookData: "0x" };
  });
}

/** Reverse hop/route index order — selling walks the exact same buy-direction
 *  table backwards, exactly like BallastRouterV2._reverseIdx. */
export function reverseIdx(idx: number[]): number[] {
  return [...idx].reverse();
}
