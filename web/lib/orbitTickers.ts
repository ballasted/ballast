import "server-only";
import { createPublicClient, http, defineChain, type Address } from "viem";
import { assetRegistryAbi, ballastFactoryAbi, erc20Abi } from "@/lib/abis";
import { ASSET_REGISTRY_ADDRESS, FACTORY_ADDRESS } from "@/lib/contracts";

// Landing-page hero orbit tickers, read SERVER-SIDE only (same "server-only" +
// plain-viem pattern as lib/heroStats.ts) — the marketing tree must never pull
// in wagmi/web3.
//
// Prefers the GREEN quote-asset subset (BallastFactory.isGreenQuoteAsset) —
// the literal "live quote-asset list" — but that function only exists on the
// multi-quote-asset-capable factory, which isn't deployed yet (every call
// fails on the current factory, same as MAX_QUOTE_ASSETS()). Rather than show
// nothing until that deploy lands, this falls back to the full live
// AssetRegistry allowlist, then to a static default if even that is
// unavailable — never a hardcoded ticker when a live one exists, never a
// blank orbit when neither does.

const RPC = process.env.RPC_UPSTREAM_URL || "https://rpc.mainnet.chain.robinhood.com";

const FALLBACK_TICKERS = ["SGOV", "NVDA", "AAPL", "SPY"];

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export async function getOrbitTickers(): Promise<string[]> {
  if (!ASSET_REGISTRY_ADDRESS) return FALLBACK_TICKERS;
  try {
    const client = createPublicClient({ chain, transport: http(RPC) });

    const assets = (await client.readContract({
      address: ASSET_REGISTRY_ADDRESS,
      abi: assetRegistryAbi,
      functionName: "allowedAssets",
    })) as Address[];
    if (assets.length === 0) return FALLBACK_TICKERS;

    let tickerSourceAssets: Address[] = assets;
    const factory = FACTORY_ADDRESS;
    if (factory) {
      const greenChecks = await client.multicall({
        contracts: assets.map(
          (a) =>
            ({
              address: factory,
              abi: ballastFactoryAbi,
              functionName: "isGreenQuoteAsset",
              args: [a],
            }) as const,
        ),
        allowFailure: true,
      });
      const greenAssets = assets.filter(
        (_, i) => greenChecks[i]?.status === "success" && greenChecks[i]?.result === true,
      );
      if (greenAssets.length > 0) tickerSourceAssets = greenAssets;
    }

    const symbolResults = await client.multicall({
      contracts: tickerSourceAssets.map((a) => ({ address: a, abi: erc20Abi, functionName: "symbol" as const })),
    });
    const tickers = symbolResults
      .filter((r) => r.status === "success")
      .map((r) => r.result as string);

    return tickers.length > 0 ? tickers : FALLBACK_TICKERS;
  } catch {
    return FALLBACK_TICKERS;
  }
}
