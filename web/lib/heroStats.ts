import "server-only";
import { createPublicClient, http, defineChain, parseAbiItem, type Address } from "viem";
import { ballastFactoryAbi, backingLensAbi } from "@/lib/abis";

// Landing-page hero figures, read SERVER-SIDE only. The marketing tree must never
// pull in wagmi/web3 (it's ~108 kB with none), so the browser receives plain
// numbers as props — this module imports viem but is `server-only`, so it can only
// ever run on the server and never lands in a client bundle.
//
// Same source as Discover (factory registry + BackingLens), so the figures
// reconcile by construction — no separately maintained counters. On any read
// failure it returns available:false, and the UI keeps dashes with a quiet
// "unavailable" (never a zero, never a guess).

const RPC = process.env.RPC_UPSTREAM_URL || "https://rpc.mainnet.chain.robinhood.com";
const FACTORY = process.env.NEXT_PUBLIC_FACTORY_ADDRESS as Address | undefined;
const LENS = process.env.NEXT_PUBLIC_LENS_ADDRESS as Address | undefined;

// ~7 days at this chain's ~100ms blocks. "Launch block within 7 days" = a launch
// event in this many blocks — computable from chain alone, no indexer/timestamps.
const WEEK_BLOCKS = 6_048_000n;

const LAUNCHED_EVENT = parseAbiItem(
  "event Launched(uint256 indexed id, address indexed creator, address indexed token, address treasury, uint256 noticePeriod, string metadataURI)",
);

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export type HeroStats = {
  available: boolean;
  ballastedProjects?: number; // registry entries whose treasury value > 0
  totalBallastUsd?: number; // sum of treasury USD across all projects (dollars)
  launchesThisWeek?: number; // launches within ~7 days
};

export async function getHeroStats(): Promise<HeroStats> {
  if (!FACTORY || !LENS) return { available: false };
  try {
    const client = createPublicClient({ chain, transport: http(RPC) });

    const count = Number(
      await client.readContract({ address: FACTORY, abi: ballastFactoryAbi, functionName: "launchCount" }),
    );
    if (count === 0) return { available: true, ballastedProjects: 0, totalBallastUsd: 0, launchesThisWeek: 0 };

    // Registry rows → treasuries (same enumeration Discover uses).
    const rows = await client.multicall({
      contracts: Array.from({ length: count }, (_, i) => ({
        address: FACTORY,
        abi: ballastFactoryAbi,
        functionName: "launches" as const,
        args: [BigInt(i)],
      })),
    });
    const treasuries = rows
      .map((r) => (r.status === "success" ? (r.result as readonly [Address, Address, Address])[1] : undefined))
      .filter((t): t is Address => Boolean(t));

    // backingOf(treasury) for each — the exact source Discover reads.
    const backings = await client.multicall({
      contracts: treasuries.map((t) => ({
        address: LENS,
        abi: backingLensAbi,
        functionName: "backingOf" as const,
        args: [t],
      })),
    });

    let ballastedProjects = 0;
    let totalWad = 0n;
    for (const b of backings) {
      if (b.status !== "success") continue;
      const tvl = (b.result as unknown as { totalValueUsd: bigint }).totalValueUsd;
      if (tvl > 0n) ballastedProjects++;
      totalWad += tvl;
    }

    // Launches this week: Launched events within the ~7-day block window.
    let launchesThisWeek = 0;
    try {
      const latest = await client.getBlockNumber();
      const fromBlock = latest > WEEK_BLOCKS ? latest - WEEK_BLOCKS : 0n;
      const logs = await client.getLogs({ address: FACTORY, event: LAUNCHED_EVENT, fromBlock, toBlock: "latest" });
      launchesThisWeek = logs.length;
    } catch {
      // If the log scan fails but the reads above succeeded, fall back to the total
      // count rather than failing the whole strip — better a slightly loose "this
      // week" than dashes when we do have the other two figures.
      launchesThisWeek = count;
    }

    return {
      available: true,
      ballastedProjects,
      totalBallastUsd: Number(totalWad) / 1e18,
      launchesThisWeek,
    };
  } catch {
    return { available: false };
  }
}
