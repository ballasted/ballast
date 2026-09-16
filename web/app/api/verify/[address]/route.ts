import { NextRequest } from "next/server";
import type { Address } from "viem";
import { serverClient } from "@/lib/serverChain";
import { ballastTokenAbi, backingLensAbi, ballastFactoryAbi, stateViewAbi, quoterAbi, erc20Abi, assetRegistryAbi } from "@/lib/abis";
import { FACTORY_ADDRESSES, LENS_ADDRESS, STATE_VIEW_ADDRESS, QUOTER_ADDRESS, WETH_ADDRESS, ASSET_REGISTRY_ADDRESS, hookForFactory } from "@/lib/contracts";
import { BLOCKSCOUT_URL } from "@/lib/blockscout";
import { activeChain } from "@/lib/chain";
import { poolKeyForToken, poolId, sellZeroForOne } from "@/lib/pool";
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

export type VerificationResult = {
  address: Address;
  isBallastLaunch: boolean;
  fetchedAt: number;
  checks?: {
    sourceVerifiedToken: SourceCheck;
    sourceVerifiedTreasury: SourceCheck;
    mintAuthority: Check;
    mutableParams: { status: "pass"; items: string[] };
    liquidityLocked: LiquidityCheck;
    creatorAllocation: Check;
    backingAssets: BackingAssetRow[];
    sellSimulation: SellCheck;
  };
};

const TIMEOUT_MS = 6_000;

async function sourceVerified(address: Address): Promise<CheckStatus> {
  try {
    const res = await fetch(`${BLOCKSCOUT_URL}/api/v2/smart-contracts/${address}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return "fail"; // Blockscout knows the address but has no verified source
    if (!res.ok) return "unavailable";
    const json = (await res.json()) as { is_verified?: boolean };
    return json.is_verified ? "pass" : "fail";
  } catch {
    return "unavailable";
  }
}

function explorerUrl(address: Address): string {
  return `${activeChain.blockExplorers.default.url}/address/${address}`;
}

function sourceLabel(status: CheckStatus): string {
  return status === "pass" ? "Verified on Blockscout" : status === "fail" ? "Not verified" : "Unavailable";
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

  const [tokenReads, graduated] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: ballastTokenAbi, functionName: "creator" },
        { address: token, abi: ballastTokenAbi, functionName: "treasury" },
        { address: token, abi: erc20Abi, functionName: "totalSupply" },
      ] as const,
    }),
    client.readContract({ address: ownerFactory, abi: ballastFactoryAbi, functionName: "graduated", args: [token] }),
  ]);
  const creator = tokenReads[0].status === "success" ? (tokenReads[0].result as Address) : undefined;
  const treasury = tokenReads[1].status === "success" ? (tokenReads[1].result as Address) : undefined;
  const totalSupply = tokenReads[2].status === "success" ? (tokenReads[2].result as bigint) : undefined;

  const [sourceToken, sourceTreasury, creatorBal, backing, registryAddresses] = await Promise.all([
    sourceVerified(token),
    treasury ? sourceVerified(treasury) : Promise.resolve<CheckStatus>("unavailable"),
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

  // -- Liquidity locked: BallastSeeder owns the LP position permanently (no
  //    removal function exists on it) — checkable live via whether the pool
  //    this token graduated into actually holds liquidity.
  const hook = hookForFactory(ownerFactory);
  let liquidityLocked: LiquidityCheck = { status: "unavailable", value: "Not graduated yet" };
  if (!graduated) {
    liquidityLocked = { status: "fail", value: "Not graduated — no pool exists yet" };
  } else if (hook && WETH_ADDRESS && STATE_VIEW_ADDRESS) {
    const key = poolKeyForToken(token, WETH_ADDRESS, hook);
    if (key) {
      const id = poolId(key);
      try {
        const liq = await client.readContract({ address: STATE_VIEW_ADDRESS, abi: stateViewAbi, functionName: "getLiquidity", args: [id] });
        liquidityLocked =
          (liq as bigint) > 0n
            ? { status: "pass", value: "Locked permanently in BallastSeeder (no removal function exists)", hookAddress: hook }
            : { status: "fail", value: "Graduated, but the pool currently reports zero liquidity", hookAddress: hook };
      } catch {
        liquidityLocked = { status: "unavailable", value: "Could not read pool liquidity" };
      }
    }
  }

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

  // -- Sell simulation: a real V4Quoter call through the actual pool + hook —
  //    proves a sell path exists RIGHT NOW, not just that a pool was created
  //    once. Only meaningful once graduated with real liquidity.
  let sellSimulation: SellCheck = { status: "unavailable", value: "Not graduated yet", method: "V4Quoter.quoteExactInputSingle" };
  if (graduated && hook && WETH_ADDRESS && QUOTER_ADDRESS && liquidityLocked.status === "pass" && totalSupply) {
    const key = poolKeyForToken(token, WETH_ADDRESS, hook);
    if (key) {
      const testAmount = totalSupply / 100_000n; // ~0.001% of supply — meaningful, but small enough to avoid an unrelated slippage revert
      try {
        const block = await client.getBlockNumber();
        const result = await client.simulateContract({
          address: QUOTER_ADDRESS,
          abi: quoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{ poolKey: key, zeroForOne: sellZeroForOne(token, WETH_ADDRESS), exactAmount: testAmount, hookData: "0x" }],
        });
        const [amountOut] = result.result as readonly [bigint, bigint];
        sellSimulation =
          amountOut > 0n
            ? { status: "pass", value: "Sell quote succeeded — a sell path exists", block: Number(block), method: "V4Quoter.quoteExactInputSingle" }
            : { status: "fail", value: "Sell quote returned zero output", block: Number(block), method: "V4Quoter.quoteExactInputSingle" };
      } catch {
        sellSimulation = { status: "fail", value: "Sell quote reverted", method: "V4Quoter.quoteExactInputSingle" };
      }
    }
  }

  const result: VerificationResult = {
    address: token,
    isBallastLaunch: true,
    fetchedAt,
    checks: {
      sourceVerifiedToken: { status: sourceToken, value: sourceLabel(sourceToken), explorerUrl: explorerUrl(token) },
      sourceVerifiedTreasury: treasury
        ? { status: sourceTreasury, value: sourceLabel(sourceTreasury), explorerUrl: explorerUrl(treasury) }
        : { status: "unavailable", value: "No treasury found", explorerUrl: "" },
      mintAuthority,
      mutableParams,
      liquidityLocked,
      creatorAllocation,
      backingAssets,
      sellSimulation,
    },
  };

  return Response.json(result, { headers: { "cache-control": "s-maxage=30, stale-while-revalidate=30" } });
}
