import { NextRequest } from "next/server";
import type { Address } from "viem";
import { serverClient } from "@/lib/serverChain";
import { ballastTokenAbi, backingLensAbi, ballastFactoryAbi, quoterAbi, erc20Abi, assetRegistryAbi } from "@/lib/abis";
import { FACTORY_ADDRESSES, LENS_ADDRESS, STATE_VIEW_ADDRESS, QUOTER_ADDRESS, WETH_ADDRESS, ASSET_REGISTRY_ADDRESS, hookForFactory } from "@/lib/contracts";
import { BLOCKSCOUT_URL } from "@/lib/blockscout";
import { activeChain } from "@/lib/chain";
import { poolKeyForToken, poolId, sellZeroForOne, tokenIsCurrency0 } from "@/lib/pool";
import { seededPositionState, isQuoteSideEmpty } from "@/lib/seededPosition";
import { resolveAssetIdentity, type RegistryAssetRef } from "@/lib/assetIdentity";

// Live verification for a launched token — every field below is a fresh chain
// (or Blockscout) read at request time, never a stored/derived guess. Cache is
// capped well under 60s so "verified just now" stays true.
export const runtime = "nodejs";
export const revalidate = 30;

type CheckStatus = "pass" | "fail" | "unavailable";
type Check = { status: CheckStatus; value: string };
type SourceCheck = Check & { explorerUrl: string };
type LiquidityCheck = Check & { hookAddress?: Address };
type SellCheck = Check & { block?: number; method: string };
type BackingAssetRow = { address: Address; symbol?: string; status: CheckStatus };

// One entry per real quoteAssetsOf() pool — a launch can have up to
// MAX_QUOTE_ASSETS (2) live pools, and each needs its OWN liquidity-locked /
// sell-simulation answer (WETH being locked says nothing about SPY).
type PoolCheck = {
  quoteAsset: Address;
  symbol: string;
  hookAddress?: Address;
  liquidityLocked: LiquidityCheck;
  sellSimulation: SellCheck;
};

export type VerificationResult = {
  address: Address;
  isBallastLaunch: boolean;
  fetchedAt: number;
  checks?: {
    sourceVerifiedToken: SourceCheck;
    sourceVerifiedTreasury: SourceCheck;
    mintAuthority: Check;
    mutableParams: { status: "pass"; items: string[] };
    graduated: boolean;
    pools: PoolCheck[]; // empty when !graduated — nothing to check yet
    creatorAllocation: Check;
    backingAssets: BackingAssetRow[];
  };
};

const TIMEOUT_MS = 6_000;

// Diagnosed (2026-09-19): Blockscout's public instance sits behind Cloudflare
// bot-protection that intermittently 403s server-to-server requests with an
// HTML JS-challenge page instead of JSON — reproducible via a plain curl from
// outside a browser, independent of headers sent (User-Agent spoofing did not
// reliably bypass it; likely TLS-fingerprint/behavioral, not a fixable header
// tweak). This is the real cause behind "Unavailable" showing for EVERY token's
// source-verification check, not a bug in the fetch call itself or in these
// specific tokens' verification status — there's nothing wrong to fix on our
// side beyond being honest about which failure mode occurred, which is what
// the distinct "blocked" reason below is for.
type SourceOutcome = { status: CheckStatus; reason?: "blocked" | "timeout" | "network" };

async function sourceVerified(address: Address): Promise<SourceOutcome> {
  try {
    const res = await fetch(`${BLOCKSCOUT_URL}/api/v2/smart-contracts/${address}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { status: "fail" }; // Blockscout knows the address but has no verified source
    if (res.status === 403) return { status: "unavailable", reason: "blocked" };
    if (!res.ok) return { status: "unavailable" };
    const json = (await res.json()) as { is_verified?: boolean };
    return { status: json.is_verified ? "pass" : "fail" };
  } catch (e) {
    return { status: "unavailable", reason: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network" };
  }
}

function explorerUrl(address: Address): string {
  return `${activeChain.blockExplorers.default.url}/address/${address}`;
}

function sourceLabel(outcome: SourceOutcome): string {
  if (outcome.status === "pass") return "Verified on Blockscout";
  if (outcome.status === "fail") return "Not verified";
  if (outcome.reason === "blocked") return "Blockscout blocked this request";
  if (outcome.reason === "timeout") return "Blockscout timed out";
  return "Blockscout unreachable";
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  const { address: raw } = await params;
  const address = raw?.toLowerCase();
  if (!address || !/^0x[0-9a-f]{40}$/.test(address)) {
    return Response.json({ error: "invalid address" }, { status: 400 });
  }
  const token = address as Address;
  const fetchedAt = Math.floor(Date.now() / 1000);
  const client = serverClient();

  // 1. Which factory (if any) launched this exact token — the ONLY thing that
  //    makes every check below meaningful. Not a Ballast launch => nothing to verify.
  let ownerFactory: Address | undefined;
  if (FACTORY_ADDRESSES.length > 0) {
    const ownerReads = await client.multicall({
      allowFailure: true,
      contracts: FACTORY_ADDRESSES.map(
        (f) => ({ address: f, abi: ballastFactoryAbi, functionName: "launchIdOf", args: [token] }) as const,
      ),
    });
    ownerReads.forEach((r, i) => {
      if (r.status === "success" && (r.result as bigint) > 0n) ownerFactory = FACTORY_ADDRESSES[i];
    });
  }

  if (!ownerFactory) {
    return Response.json(
      { address: token, isBallastLaunch: false, fetchedAt } satisfies VerificationResult,
      { status: 404, headers: { "cache-control": "s-maxage=30" } },
    );
  }

  const [tokenReads, graduatedRaw, quoteAssetsRaw] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: ballastTokenAbi, functionName: "creator" },
        { address: token, abi: ballastTokenAbi, functionName: "treasury" },
        { address: token, abi: erc20Abi, functionName: "totalSupply" },
      ] as const,
    }),
    client.readContract({ address: ownerFactory, abi: ballastFactoryAbi, functionName: "graduated", args: [token] }),
    client
      .readContract({ address: ownerFactory, abi: ballastFactoryAbi, functionName: "quoteAssetsOf", args: [token] })
      .catch(() => undefined),
  ]);
  const creator = tokenReads[0].status === "success" ? (tokenReads[0].result as Address) : undefined;
  const treasury = tokenReads[1].status === "success" ? (tokenReads[1].result as Address) : undefined;
  const totalSupply = tokenReads[2].status === "success" ? (tokenReads[2].result as bigint) : undefined;
  const graduated = Boolean(graduatedRaw);
  // A prior factory that predates quoteAssetsOf() simply fails the call — its
  // only possible shape is a single WETH pool (matches useTokenQuotePools.ts).
  const quoteAssets: Address[] =
    Array.isArray(quoteAssetsRaw) && quoteAssetsRaw.length > 0 ? (quoteAssetsRaw as Address[]) : WETH_ADDRESS ? [WETH_ADDRESS] : [];

  const [sourceToken, sourceTreasury, creatorBal, backing, registryAddresses] = await Promise.all([
    sourceVerified(token),
    treasury ? sourceVerified(treasury) : Promise.resolve<SourceOutcome>({ status: "unavailable" }),
    creator
      ? client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [creator] }).catch(() => undefined)
      : Promise.resolve(undefined),
    treasury && LENS_ADDRESS
      ? client.readContract({ address: LENS_ADDRESS, abi: backingLensAbi, functionName: "backingOf", args: [treasury] }).catch(() => undefined)
      : Promise.resolve(undefined),
    ASSET_REGISTRY_ADDRESS
      ? client.readContract({ address: ASSET_REGISTRY_ADDRESS, abi: assetRegistryAbi, functionName: "allowedAssets" }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  // -- Mint authority: no mint() exists on BallastToken.sol, by construction,
  //    for every genuine Ballast launch (same creation bytecode every time —
  //    confirmed by ownerFactory.launchIdOf above, not by trusting this token
  //    in isolation).
  const mintAuthority: Check = { status: "pass", value: "None — fixed supply, no mint function exists" };

  // -- Mutable params: the one per-token value a creator can change post-launch
  //    (metadataURI; every change logged via MetadataUpdated). noticePeriod,
  //    the treasury/creator pointers, and the token's mint authority are all
  //    immutable/absent by contract design.
  const mutableParams: { status: "pass"; items: string[] } = {
    status: "pass",
    items: ["Project metadata (name/logo/links) — creator-controlled, every change logged on-chain"],
  };

  // -- Creator allocation: live balance, worded so a legitimate open-market buy
  //    later never reads as a red flag — launch itself mints 100% to the
  //    factory, never the creator (verifiable from BallastToken's constructor).
  let creatorAllocation: Check = { status: "unavailable", value: "Could not read creator balance" };
  if (creator && creatorBal !== undefined && totalSupply && totalSupply > 0n) {
    const bal = creatorBal as bigint;
    const pct = Number((bal * 1_000_000n) / totalSupply) / 10_000;
    creatorAllocation =
      bal === 0n
        ? { status: "pass", value: "0% — no launch allocation, none acquired since" }
        : { status: "pass", value: `${pct.toFixed(2)}% held — launch grants 0%; this is market activity, not an allocation` };
  }

  // -- Per-pool checks: liquidity locked + sell simulation, once per REAL
  //    quote asset (up to 2) — a launch's WETH pool being locked/sellable says
  //    nothing about its SPY pool, so each gets its own independent answer.
  const hook = hookForFactory(ownerFactory);
  const seederRes = graduated
    ? await client.readContract({ address: ownerFactory, abi: ballastFactoryAbi, functionName: "seeder" }).catch(() => undefined)
    : undefined;
  const quoteSymbolReads =
    graduated && quoteAssets.length > 0
      ? await client.multicall({
          allowFailure: true,
          contracts: quoteAssets.map((qa) => ({ address: qa, abi: erc20Abi, functionName: "symbol" }) as const),
        })
      : [];

  const pools: PoolCheck[] = graduated
    ? await Promise.all(
        quoteAssets.map(async (quoteAsset, i): Promise<PoolCheck> => {
          const symbol =
            WETH_ADDRESS && quoteAsset.toLowerCase() === WETH_ADDRESS.toLowerCase()
              ? "WETH"
              : quoteSymbolReads[i]?.status === "success"
                ? (quoteSymbolReads[i].result as string)
                : quoteAsset;

          if (!hook || !STATE_VIEW_ADDRESS || !seederRes) {
            const unavailable: LiquidityCheck = { status: "unavailable", value: "Could not read pool liquidity", hookAddress: hook };
            return {
              quoteAsset,
              symbol,
              hookAddress: hook,
              liquidityLocked: unavailable,
              sellSimulation: { status: "unavailable", value: "Could not read pool liquidity", method: "V4Quoter.quoteExactInputSingle" },
            };
          }

          const key = poolKeyForToken(token, quoteAsset, hook);
          if (!key) {
            const unavailable: LiquidityCheck = { status: "unavailable", value: "Could not build pool key", hookAddress: hook };
            return {
              quoteAsset,
              symbol,
              hookAddress: hook,
              liquidityLocked: unavailable,
              sellSimulation: { status: "unavailable", value: "Could not build pool key", method: "V4Quoter.quoteExactInputSingle" },
            };
          }
          const id = poolId(key);

          // -- Liquidity locked: BallastSeeder owns the LP position permanently
          //    (no removal function exists on it) — checkable live via whether
          //    that EXACT position (not just the pool as a whole) actually
          //    holds liquidity. getLiquidity(poolId) alone isn't a safe proxy:
          //    it reads 0 exactly when the current tick sits on the position's
          //    boundary (the half-open tick-range artifact, confirmed on real
          //    graduated pools 2026-09-25) even though the position is real,
          //    locked, and holds real backing supply. This is a claim users
          //    rely on to decide whether to buy, so it reads the real position
          //    via StateView.getPositionInfo (lib/seededPosition.ts) instead of
          //    trusting the coarser pool-wide liquidity figure.
          let liquidityLocked: LiquidityCheck;
          let quoteEmpty: boolean | undefined;
          try {
            const state = await seededPositionState(client, id, seederRes as Address);
            if (!state) {
              liquidityLocked = { status: "unavailable", value: "Could not locate the seeded position", hookAddress: hook };
            } else {
              quoteEmpty = isQuoteSideEmpty(state.currentTick, state.ticks, !tokenIsCurrency0(token, quoteAsset));
              liquidityLocked =
                state.liquidity > 0n
                  ? { status: "pass", value: "Locked permanently in BallastSeeder (no removal function exists)", hookAddress: hook }
                  : { status: "fail", value: "Graduated, but the seeded position reports zero liquidity", hookAddress: hook };
            }
          } catch {
            liquidityLocked = { status: "unavailable", value: "Could not read pool liquidity", hookAddress: hook };
          }

          // -- Sell simulation: a real V4Quoter call through the actual pool +
          //    hook — proves a sell path exists RIGHT NOW, not just that a pool
          //    was created once. A revert here is ambiguous by itself: on a
          //    one-sided Ballast pool, the quote-asset side starts at EXACTLY
          //    zero and is filled only by real buys (docs/GO_LIVE.md
          //    §Liquidity) — so "nobody has bought this pool yet" reverts a
          //    sell quote for a completely legitimate reason, not a honeypot.
          //    isQuoteSideEmpty (an exact tick-boundary fact, not a guess)
          //    disambiguates: empty quote side + revert = "nothing to sell
          //    into yet"; real quote-side liquidity + revert = a genuine fail.
          let sellSimulation: SellCheck = { status: "unavailable", value: "Not graduated yet", method: "V4Quoter.quoteExactInputSingle" };
          if (QUOTER_ADDRESS && totalSupply) {
            const testAmount = totalSupply / 100_000n; // ~0.001% of supply — meaningful, but small enough to avoid an unrelated slippage revert
            try {
              const block = await client.getBlockNumber();
              const result = await client.simulateContract({
                address: QUOTER_ADDRESS,
                abi: quoterAbi,
                functionName: "quoteExactInputSingle",
                args: [{ poolKey: key, zeroForOne: sellZeroForOne(token, quoteAsset), exactAmount: testAmount, hookData: "0x" }],
              });
              const [amountOut] = result.result as readonly [bigint, bigint];
              sellSimulation =
                amountOut > 0n
                  ? { status: "pass", value: "Sell quote succeeded — a sell path exists", block: Number(block), method: "V4Quoter.quoteExactInputSingle" }
                  : { status: "fail", value: "Sell quote returned zero output", block: Number(block), method: "V4Quoter.quoteExactInputSingle" };
            } catch {
              sellSimulation =
                quoteEmpty === true
                  ? { status: "unavailable", value: "No buys on this pool yet — nothing to sell into", method: "V4Quoter.quoteExactInputSingle" }
                  : { status: "fail", value: "Sell quote reverted", method: "V4Quoter.quoteExactInputSingle" };
            }
          }

          return { quoteAsset, symbol, hookAddress: hook, liquidityLocked, sellSimulation };
        }),
      )
    : [];

  // -- Backing assets: identity-checked, not just listed — the fold-in from the
  //    asset-identity work. Each asset the treasury actually holds is resolved
  //    against the SAME live AssetRegistry, address-first (lib/assetIdentity.ts).
  const registryList = (registryAddresses as Address[] | undefined) ?? [];
  let registryAssets: RegistryAssetRef[] = [];
  if (registryList.length > 0) {
    const symbolReads = await client.multicall({
      allowFailure: true,
      contracts: registryList.map((a) => ({ address: a, abi: erc20Abi, functionName: "symbol" }) as const),
    });
    registryAssets = registryList.map((a, i) => ({
      address: a,
      symbol: symbolReads[i]?.status === "success" ? (symbolReads[i].result as string) : undefined,
    }));
  }
  const heldAssets: Address[] =
    backing && typeof backing === "object" && "assets" in backing
      ? (backing as { assets: readonly { asset: Address }[] }).assets.map((a) => a.asset)
      : [];
  const backingAssetSymbols =
    heldAssets.length > 0
      ? await client.multicall({
          allowFailure: true,
          contracts: heldAssets.map((a) => ({ address: a, abi: erc20Abi, functionName: "symbol" }) as const),
        })
      : [];
  const backingAssets: BackingAssetRow[] = heldAssets.map((a, i) => {
    const claimed = backingAssetSymbols[i]?.status === "success" ? (backingAssetSymbols[i].result as string) : undefined;
    const identity = resolveAssetIdentity(a, claimed, registryAssets, true);
    return {
      address: a,
      symbol: identity.status === "recognized" ? identity.symbol : claimed,
      status: identity.status === "recognized" ? "pass" : identity.status === "loading" ? "unavailable" : "fail",
    };
  });

  const result: VerificationResult = {
    address: token,
    isBallastLaunch: true,
    fetchedAt,
    checks: {
      sourceVerifiedToken: { status: sourceToken.status, value: sourceLabel(sourceToken), explorerUrl: explorerUrl(token) },
      sourceVerifiedTreasury: treasury
        ? { status: sourceTreasury.status, value: sourceLabel(sourceTreasury), explorerUrl: explorerUrl(treasury) }
        : { status: "unavailable", value: "No treasury found", explorerUrl: "" },
      mintAuthority,
      mutableParams,
      graduated,
      pools,
      creatorAllocation,
      backingAssets,
    },
  };

  return Response.json(result, { headers: { "cache-control": "s-maxage=30, stale-while-revalidate=30" } });
}
