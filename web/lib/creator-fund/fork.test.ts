import { describe, it, expect } from "vitest";
import { createPublicClient, defineChain, http, parseAbiItem, type Address } from "viem";
import { resolveQuoteFeeds, feedPricesAtBlocks } from "./pricing";
import { balancesFromTransfers, countHolders, type Transfer } from "./holders";

// Fork/integration test — runs ONLY when an RPC is configured (RH_RPC_URL_PAID, the
// campaign brief's endpoint, or RPC_UPSTREAM_URL). vitest does not load .env, so set
// the var in the shell: RH_RPC_URL_PAID=... npx vitest run lib/creator-fund/fork.
// Canonical addresses are inlined (same values as .env.example) so this test does
// not depend on contracts.ts env being loaded.
const RPC = process.env.RH_RPC_URL_PAID || process.env.RPC_UPSTREAM_URL;

const ASSET_REGISTRY = "0x427764d0d19aB765c35A41A5aa4771580307dA81" as Address;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const ETH_USD_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9" as Address;
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
const SGOV = "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5" as Address;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as Address;
// Real graduated tokens (from swapDirection fixtures) used as holder fixtures.
const FIXTURE_TOKENS = [
  "0xf7e04472be047263885480dab2c42ab75b1386c1",
  "0xa9b587b4945c587455ad28c16b032e0034db3a44",
] as Address[];

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC ?? "http://localhost"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

describe.skipIf(!RPC)("Creator Fund — fork pricing + holders", () => {
  const client = createPublicClient({ chain, transport: http(RPC) });

  it(
    "resolves real Chainlink feeds for WETH + stock quotes and prices them > 0",
    async () => {
      const feeds = await resolveQuoteFeeds(client, [WETH, SGOV, NVDA], {
        registry: ASSET_REGISTRY,
        weth: WETH,
        ethUsdFeed: ETH_USD_FEED,
      });
      for (const a of [WETH, SGOV, NVDA]) {
        const f = feeds.get(a.toLowerCase());
        expect(f, `feed for ${a}`).toBeTruthy();
        expect(f!.feedDecimals).toBeGreaterThan(0);
        expect(f!.tokenDecimals).toBeGreaterThan(0);
      }
      expect(feeds.get(WETH.toLowerCase())!.feed.toLowerCase()).toBe(ETH_USD_FEED.toLowerCase());

      const latest = Number(await client.getBlockNumber());
      const needs = Array.from(feeds.values()).map((f) => ({ feed: f.feed, feedDecimals: f.feedDecimals, block: latest }));
      const prices = await feedPricesAtBlocks(client, needs);
      for (const f of feeds.values()) {
        const p = prices.get(`${f.feed.toLowerCase()}|${latest}`);
        expect(p, `price for ${f.feed}`).toBeGreaterThan(0);
      }
    },
    120_000,
  );

  it(
    "reconstructs holder balances from real Transfer logs and excludes the pool manager",
    async () => {
      const latest = await client.getBlockNumber();
      const from = latest > 200_000n ? latest - 200_000n : 0n;

      for (const token of FIXTURE_TOKENS) {
        const logs = await client.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: latest });
        const transfers: Transfer[] = logs.map((l) => ({
          from: l.args.from!,
          to: l.args.to!,
          value: l.args.value!,
          blockNumber: Number(l.blockNumber),
          blockTs: 0,
          logIndex: l.logIndex ?? 0,
        }));
        const bal = balancesFromTransfers(transfers);

        // Conservation on real data: every delta (incl. the zero address) nets to 0.
        let sum = 0n;
        for (const v of bal.values()) sum += v;
        expect(sum).toBe(0n);

        // Excluding the pool manager never increases the holder count, and strictly
        // drops it when the pool manager holds a balance in this window.
        const withPool = countHolders(bal, new Set());
        const withoutPool = countHolders(bal, new Set([POOL_MANAGER.toLowerCase()]));
        expect(withoutPool).toBeLessThanOrEqual(withPool);
        expect(withoutPool).toBeGreaterThanOrEqual(0);
      }
    },
    180_000,
  );
});
