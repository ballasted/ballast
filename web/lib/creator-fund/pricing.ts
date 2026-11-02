// ─────────────────────────────────────────────────────────────────────────────
// Creator Fund — USD pricing of swaps, priced at the block the swap happened.
//
// METHOD (documented, and the same two-tier source the live indexer uses):
//   • Each swap moves a known amount of the pool's QUOTE asset (the non-launched-
//     token side). We value the quote side, never the launched token, because the
//     quote is the asset with an authoritative USD oracle.
//   • WETH quote  → the Chainlink ETH/USD STANDARD feed (NEXT_PUBLIC_ETH_USD_FEED_
//     ADDRESS = 0x78F3…d3A9).
//   • Stock-token quote (NVDA/SPY/SGOV/…) → that asset's Chainlink feed, read from
//     AssetRegistry.assetConfig(asset).feed (the Standard proxy — rule 15).
//   • The price is read AT THE SWAP'S BLOCK via latestRoundData() archive calls, so
//     historical volume reflects the price then, not a flat current price.
//   • USD(swap) = (quoteAbs / 10^quoteTokenDecimals) × (answer / 10^feedDecimals).
//
// A swap whose quote asset has no resolvable feed contributes NULL (not 0) USD — it
// is surfaced as "unpriced", never silently counted as zero. Feed decimals are read
// from the feed (CLAUDE.md rule 9 — never hardcode), token decimals from the ERC-20.
// We do NOT apply any uiMultiplier (rule 7 — the feed already includes it).
// ─────────────────────────────────────────────────────────────────────────────
import { formatUnits, type Address, type PublicClient } from "viem";
import { aggregatorV3Abi, assetRegistryAbi, erc20Abi } from "../abis";

export type QuoteFeed = {
  asset: Address;
  feed: Address;
  feedDecimals: number;
  tokenDecimals: number;
};

/** Pure: USD value of a quote-side amount given its token decimals and a USD price. */
export function usdOfQuote(quoteAbs: bigint, tokenDecimals: number, priceUsd: number): number {
  const nQuote = Number(formatUnits(quoteAbs, tokenDecimals));
  return nQuote * priceUsd;
}

/** Pure: a feed answer (int) as a float USD price, using the feed's decimals. */
export function priceFromAnswer(answer: bigint, feedDecimals: number): number {
  return Number(formatUnits(answer, feedDecimals));
}

/**
 * Resolve the Chainlink feed + both relevant decimals for each quote asset.
 * WETH maps to the ETH/USD feed; every other asset to AssetRegistry's configured
 * feed. Returns a map keyed by lowercased asset address; assets with no feed (or a
 * registry that doesn't allow them) are simply absent.
 */
export async function resolveQuoteFeeds(
  client: PublicClient,
  assets: Address[],
  opts: { registry: Address; weth: Address; ethUsdFeed: Address },
): Promise<Map<string, QuoteFeed>> {
  const out = new Map<string, QuoteFeed>();
  const uniq = Array.from(new Set(assets.map((a) => a.toLowerCase()))) as Address[];
  if (uniq.length === 0) return out;

  // Feed address per asset: WETH → ETH/USD, else registry.assetConfig(asset).feed.
  const nonWeth = uniq.filter((a) => a !== opts.weth.toLowerCase());
  const feedOf = new Map<string, Address>();
  feedOf.set(opts.weth.toLowerCase(), opts.ethUsdFeed);

  if (nonWeth.length > 0) {
    const cfgs = await client.multicall({
      allowFailure: true,
      contracts: nonWeth.map((asset) => ({
        address: opts.registry,
        abi: assetRegistryAbi,
        functionName: "assetConfig" as const,
        args: [asset],
      })),
    });
    nonWeth.forEach((asset, i) => {
      const r = cfgs[i];
      if (r && r.status === "success") {
        const [allowed, feed] = r.result as readonly [boolean, Address, bigint, bigint, number];
        if (allowed && feed && /^0x0{40}$/.test(feed) === false) feedOf.set(asset, feed);
      }
    });
  }

  const withFeed = Array.from(feedOf.entries());
  if (withFeed.length === 0) return out;

  // Feed decimals + token decimals, batched.
  const feedDecCalls = withFeed.map(([, feed]) => ({
    address: feed,
    abi: aggregatorV3Abi,
    functionName: "decimals" as const,
  }));
  const tokenDecCalls = withFeed.map(([asset]) => ({
    address: asset as Address,
    abi: erc20Abi,
    functionName: "decimals" as const,
  }));
  const [feedDecs, tokenDecs] = await Promise.all([
    client.multicall({ allowFailure: true, contracts: feedDecCalls }),
    client.multicall({ allowFailure: true, contracts: tokenDecCalls }),
  ]);

  withFeed.forEach(([asset, feed], i) => {
    const fd = feedDecs[i];
    const td = tokenDecs[i];
    const feedDecimals = fd && fd.status === "success" ? Number(fd.result) : 8;
    const tokenDecimals = td && td.status === "success" ? Number(td.result) : 18;
    out.set(asset, { asset: asset as Address, feed, feedDecimals, tokenDecimals });
  });
  return out;
}

/**
 * Read each (feed, block) price needed, one multicall per distinct block (so
 * every feed for that block is fetched together at the historical state). Returns
 * a map keyed "<feedLower>|<block>" → float USD price. Missing reads are absent.
 */
export async function feedPricesAtBlocks(
  client: PublicClient,
  needs: { feed: Address; feedDecimals: number; block: number }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // Group distinct (feed) per block.
  const byBlock = new Map<number, Map<string, { feed: Address; feedDecimals: number }>>();
  for (const n of needs) {
    let m = byBlock.get(n.block);
    if (!m) {
      m = new Map();
      byBlock.set(n.block, m);
    }
    m.set(n.feed.toLowerCase(), { feed: n.feed, feedDecimals: n.feedDecimals });
  }

  for (const [block, feeds] of byBlock) {
    const entries = Array.from(feeds.values());
    const res = await client.multicall({
      allowFailure: true,
      blockNumber: BigInt(block),
      contracts: entries.map((e) => ({
        address: e.feed,
        abi: aggregatorV3Abi,
        functionName: "latestRoundData" as const,
      })),
    });
    entries.forEach((e, i) => {
      const r = res[i];
      if (r && r.status === "success") {
        const [, answer] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
        if (answer > 0n) out.set(`${e.feed.toLowerCase()}|${block}`, priceFromAnswer(answer, e.feedDecimals));
      }
    });
  }
  return out;
}
