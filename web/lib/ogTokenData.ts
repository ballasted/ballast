import "server-only";
import type { Address, ContractFunctionParameters } from "viem";
import { serverClient } from "@/lib/serverChain";
import {
  backingLensAbi,
  ballastTokenAbi,
  erc20Abi,
  stateViewAbi,
  aggregatorV3Abi,
  metadataDenylistAbi,
} from "@/lib/abis";
import {
  LENS_ADDRESS,
  STATE_VIEW_ADDRESS,
  ETH_USD_FEED_ADDRESS,
  METADATA_DENYLIST_ADDRESS,
  isDenylistConfigured,
} from "@/lib/contracts";
import { candidatePoolKeys, priceFromSqrtX96 } from "@/lib/pool";

// Server-side read of the handful of figures a token's link-preview card needs:
// ticker, name, live price, and backing per token (or "not ballasted"). This runs
// only in the opengraph-image route, so it may read on-chain directly (viem) — but
// it must NEVER throw: a link preview has to render even when a read fails, so every
// step degrades to a missing figure rather than a broken image.
//
// The same sources the token page uses, so the card can't disagree with the page:
//   • token.treasury() → BackingLens.backingOf(treasury) for backingPerToken + ballasted
//   • pool sqrtPrice (StateView) × ETH/USD feed for the live USD price
//   • MetadataDenylist.entryOf(token) so a withheld name isn't leaked in the preview
// Rule compliance: backingPerToken comes straight from the lens (which already reads
// priceDecimals per asset and never re-applies uiMultiplier — rules 7/9); we only
// format it here.

export type OgTokenData = {
  found: boolean;
  symbol?: string;
  name?: string; // undefined when withheld (denylisted) or unreadable
  denied: boolean;
  ballasted: boolean;
  backingPerToken1e18?: bigint;
  priceUsd1e18?: bigint;
};

const WAD = 10n ** 18n;

export async function getOgTokenData(token: Address): Promise<OgTokenData> {
  const client = serverClient();

  // treasury() is the immutable pointer; if it doesn't read, this isn't a BALLAST
  // token on the active chain — report not-found so the route can render a generic
  // (still on-brand) card rather than a broken one.
  let treasury: Address | undefined;
  try {
    treasury = (await client.readContract({
      address: token,
      abi: ballastTokenAbi,
      functionName: "treasury",
    })) as Address;
  } catch {
    return { found: false, denied: false, ballasted: false };
  }
  if (!treasury || /^0x0+$/.test(treasury)) {
    return { found: false, denied: false, ballasted: false };
  }

  // Metadata (symbol/name), backing, and the denylist entry in one batch.
  let symbol: string | undefined;
  let name: string | undefined;
  let backingPerToken1e18: bigint | undefined;
  let ballasted = false;
  let denied = false;
  try {
    const contracts: ContractFunctionParameters[] = [
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "name" },
    ];
    if (LENS_ADDRESS)
      contracts.push({ address: LENS_ADDRESS, abi: backingLensAbi, functionName: "backingOf", args: [treasury] });
    if (isDenylistConfigured && METADATA_DENYLIST_ADDRESS)
      contracts.push({ address: METADATA_DENYLIST_ADDRESS, abi: metadataDenylistAbi, functionName: "entryOf", args: [token] });
    const reads = await client.multicall({ allowFailure: true, contracts });
    let i = 0;
    const sym = reads[i++];
    const nm = reads[i++];
    if (sym?.status === "success") symbol = sym.result as string;
    if (nm?.status === "success") name = nm.result as string;
    if (LENS_ADDRESS) {
      const b = reads[i++];
      if (b?.status === "success") {
        const r = b.result as unknown as { totalValueUsd: bigint; backingPerToken: bigint };
        backingPerToken1e18 = r.backingPerToken;
        ballasted = r.totalValueUsd > 0n;
      }
    }
    if (isDenylistConfigured && METADATA_DENYLIST_ADDRESS) {
      const d = reads[i++];
      if (d?.status === "success") {
        const [isDenied] = d.result as unknown as readonly [boolean, bigint, string];
        denied = Boolean(isDenied);
      }
    }
  } catch {
    // Leave the figures undefined — the card renders what it has.
  }

  // A denied token keeps its on-chain ticker, price and backing but its project-
  // supplied name is withheld — exactly as the token page does — so the preview
  // can't be used to boost impersonation branding.
  if (denied) name = undefined;

  // Live USD price: probe each candidate hook's pool, take the first with liquidity,
  // convert WETH→USD via the ETH/USD feed. Any gap just leaves the price blank.
  const priceUsd1e18 = await readPriceUsd(client, token);

  return {
    found: true,
    symbol,
    name,
    denied,
    ballasted,
    backingPerToken1e18,
    priceUsd1e18,
  };
}

async function readPriceUsd(
  client: ReturnType<typeof serverClient>,
  token: Address,
): Promise<bigint | undefined> {
  const stateView = STATE_VIEW_ADDRESS;
  const ethFeed = ETH_USD_FEED_ADDRESS;
  if (!stateView || !ethFeed) return undefined;
  const candidates = candidatePoolKeys(token);
  if (candidates.length === 0) return undefined;
  try {
    const poolContracts: ContractFunctionParameters[] = candidates.flatMap((c) => [
      { address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [c.id] },
      { address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [c.id] },
    ]);
    const poolReads = await client.multicall({ allowFailure: true, contracts: poolContracts });
    let priceWeth: bigint | undefined;
    for (let i = 0; i < candidates.length; i++) {
      const slot0 = poolReads[i * 2];
      const liq = poolReads[i * 2 + 1];
      if (liq?.status === "success" && (liq.result as bigint) > 0n && slot0?.status === "success") {
        const [sqrtPriceX96] = slot0.result as unknown as [bigint, number, number, number];
        if (sqrtPriceX96 > 0n) {
          priceWeth = priceFromSqrtX96(sqrtPriceX96);
          break;
        }
      }
    }
    if (priceWeth === undefined) return undefined;

    const ethContracts: ContractFunctionParameters[] = [
      { address: ethFeed, abi: aggregatorV3Abi, functionName: "latestRoundData" },
      { address: ethFeed, abi: aggregatorV3Abi, functionName: "decimals" },
    ];
    const ethReads = await client.multicall({ allowFailure: true, contracts: ethContracts });
    if (ethReads[0]?.status !== "success" || ethReads[1]?.status !== "success") return undefined;
    const answer = (ethReads[0].result as unknown as [bigint, bigint, bigint, bigint, bigint])[1];
    if (answer <= 0n) return undefined;
    const ethUsd1e18 = (answer * WAD) / 10n ** BigInt(ethReads[1].result as number);
    return (priceWeth * ethUsd1e18) / WAD;
  } catch {
    return undefined;
  }
}
