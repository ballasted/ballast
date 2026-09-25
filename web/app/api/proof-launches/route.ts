import { serverClient } from "@/lib/serverChain";
import { ballastFactoryAbi, ballastTokenAbi, backingLensAbi, erc20Abi, assetRegistryAbi } from "@/lib/abis";
import { FACTORY_ADDRESSES, LENS_ADDRESS, ASSET_REGISTRY_ADDRESS, WETH_ADDRESS, hookForFactory } from "@/lib/contracts";
import { resolveAssetIdentity, type RegistryAssetRef } from "@/lib/assetIdentity";
import type { Address } from "viem";

// Landing-hero proof card data — the SAME chain sources Discover/the token page
// use (BallastFactory union, BackingLens, AssetRegistry), just resolved fully
// server-side so the marketing bundle stays wagmi-free (see lib/heroStats.ts's
// same constraint). A launch is only included if EVERY field resolves cleanly —
// no partial rows, no placeholders, no guessing. Client polls this and rotates
// through the result client-side (no data refetch needed for the rotation itself).
export const runtime = "nodejs";
export const revalidate = 30;

const CAP = 20; // newest launches considered per refresh — enough to fill a rotation without a huge fan-out

export type ProofLaunch = {
  token: Address;
  name: string;
  symbol: string;
  backedBySymbol?: string; // address-verified against AssetRegistry server-side; client just needs the symbol to render
  quoteAssetSymbols: string[];
  backingPerTokenUsd: string; // 1e18-scaled, as a decimal string (bigint doesn't survive JSON)
  updatedAtAgeSeconds?: number; // age of the oldest priced backing asset's feed, if backed
};

export async function GET() {
  const fetchedAt = Math.floor(Date.now() / 1000);
  if (FACTORY_ADDRESSES.length === 0 || !LENS_ADDRESS) {
    return Response.json({ fetchedAt, launches: [] as ProofLaunch[] }, { headers: { "cache-control": "s-maxage=30" } });
  }
  try {
    const client = serverClient();

    // Registry list, for address-verified identity resolution (same check the
    // rest of the app uses — an impostor pool can't borrow a real logo here either).
    const registryList = ASSET_REGISTRY_ADDRESS
      ? ((await client.readContract({ address: ASSET_REGISTRY_ADDRESS, abi: assetRegistryAbi, functionName: "allowedAssets" }).catch(() => [])) as Address[])
      : [];
    const registrySymbols =
      registryList.length > 0
        ? await client.multicall({ allowFailure: true, contracts: registryList.map((a) => ({ address: a, abi: erc20Abi, functionName: "symbol" }) as const) })
        : [];
    const registry: RegistryAssetRef[] = registryList.map((address, i) => ({
      address,
      symbol: registrySymbols[i]?.status === "success" ? (registrySymbols[i].result as string) : undefined,
    }));

    // Enumerate the launch union, newest-first, owning factory tracked per token
    // (needed for quoteAssetsOf/graduated, which are per-factory calls).
    const counts = await client.multicall({
      allowFailure: true,
      contracts: FACTORY_ADDRESSES.map((f) => ({ address: f, abi: ballastFactoryAbi, functionName: "launchCount" }) as const),
    });
    const refs: { factory: Address; i: number }[] = [];
    FACTORY_ADDRESSES.forEach((f, k) => {
      const c = counts[k]?.status === "success" ? Number(counts[k].result as bigint) : 0;
      for (let i = c - 1; i >= 0 && refs.length < CAP; i--) refs.push({ factory: f, i });
    });
    if (refs.length === 0) return Response.json({ fetchedAt, launches: [] }, { headers: { "cache-control": "s-maxage=30" } });

    const rows = await client.multicall({
      allowFailure: true,
      contracts: refs.map((r) => ({ address: r.factory, abi: ballastFactoryAbi, functionName: "launches", args: [BigInt(r.i)] }) as const),
    });

    const candidates: { token: Address; treasury: Address; factory: Address }[] = [];
    const seen = new Set<string>();
    rows.forEach((r, i) => {
      if (r.status !== "success") return;
      const [token, treasury] = r.result as readonly [Address, Address, Address];
      const key = token.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push({ token, treasury, factory: refs[i]!.factory });
    });

    const graduatedRes = await client.multicall({
      allowFailure: true,
      contracts: candidates.map((c) => ({ address: c.factory, abi: ballastFactoryAbi, functionName: "graduated", args: [c.token] }) as const),
    });
    const quoteAssetsRes = await client.multicall({
      allowFailure: true,
      contracts: candidates.map((c) => ({ address: c.factory, abi: ballastFactoryAbi, functionName: "quoteAssetsOf", args: [c.token] }) as const),
    });
    const metaRes = await client.multicall({
      allowFailure: true,
      contracts: candidates.flatMap((c) => [
        { address: c.token, abi: erc20Abi, functionName: "name" } as const,
        { address: c.token, abi: erc20Abi, functionName: "symbol" } as const,
        { address: LENS_ADDRESS!, abi: backingLensAbi, functionName: "backingOf", args: [c.treasury] } as const,
      ]),
    });

    const launches: ProofLaunch[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const gradR = graduatedRes[i];
      const graduated = gradR?.status === "success" && Boolean(gradR.result);
      if (!graduated) continue; // only real, live proof — an "On curve" launch has nothing to show yet

      const nameR = metaRes[i * 3];
      const symbolR = metaRes[i * 3 + 1];
      const backingR = metaRes[i * 3 + 2];
      const quoteR = quoteAssetsRes[i];
      const name = nameR?.status === "success" ? (nameR.result as string) : undefined;
      const symbol = symbolR?.status === "success" ? (symbolR.result as string) : undefined;
      const backing = backingR?.status === "success" ? (backingR.result as unknown as {
        totalValueUsd: bigint;
        backingPerToken: bigint;
        assets: readonly { asset: Address; updatedAt: bigint; priced: boolean }[];
      }) : undefined;
      const rawQuoteAssets =
        quoteR?.status === "success" && Array.isArray(quoteR.result) && (quoteR.result as Address[]).length > 0
          ? (quoteR.result as Address[])
          : WETH_ADDRESS
            ? [WETH_ADDRESS]
            : undefined;

      // Required fields — skip (don't guess, don't placeholder) if any failed.
      if (!name || !symbol || !backing || !rawQuoteAssets || rawQuoteAssets.length === 0) continue;

      const quoteAssetSymbols: string[] = [];
      let skip = false;
      for (const qa of rawQuoteAssets) {
        const isWeth = Boolean(WETH_ADDRESS) && qa.toLowerCase() === WETH_ADDRESS!.toLowerCase();
        if (isWeth) {
          quoteAssetSymbols.push("ETH");
          continue;
        }
        const identity = resolveAssetIdentity(qa, undefined, registry, true);
        if (identity.status !== "recognized") {
          skip = true; // an unresolvable quote symbol → skip the whole row, don't half-render it
          break;
        }
        quoteAssetSymbols.push(identity.symbol);
      }
      if (skip) continue;

      const backingAssetAddr = backing.assets[0]?.asset;
      let backedBySymbol: string | undefined;
      let updatedAtAgeSeconds: number | undefined;
      if (backingAssetAddr) {
        const identity = resolveAssetIdentity(backingAssetAddr, undefined, registry, true);
        if (identity.status !== "recognized") continue; // a backing asset we can't identify → skip, don't show an unverified mark
        backedBySymbol = identity.symbol;
        const oldest = backing.assets.filter((a) => a.priced).reduce<bigint | undefined>(
          (acc, a) => (acc === undefined || a.updatedAt < acc ? a.updatedAt : acc),
          undefined,
        );
        if (oldest !== undefined) updatedAtAgeSeconds = fetchedAt - Number(oldest);
      }

      launches.push({
        token: candidates[i]!.token,
        name,
        symbol,
        backedBySymbol,
        quoteAssetSymbols,
        backingPerTokenUsd: backing.backingPerToken.toString(),
        updatedAtAgeSeconds,
      });
    }

    return Response.json({ fetchedAt, launches }, { headers: { "cache-control": "s-maxage=30, stale-while-revalidate=30" } });
  } catch {
    return Response.json({ fetchedAt, launches: [] as ProofLaunch[] }, { status: 200, headers: { "cache-control": "s-maxage=10" } });
  }
}
