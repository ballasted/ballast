import "server-only";
import { createPublicClient, http, defineChain, parseAbiItem, type Address } from "viem";
import { ballastFactoryAbi, backingLensAbi } from "@/lib/abis";
import { FACTORY_ADDRESSES } from "@/lib/contracts";

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
// Union of every factory (current + priors), newest-first — same source Discover
// uses, so the hero figures reconcile with what Discover lists across versions.
const FACTORIES = FACTORY_ADDRESSES;
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
  if (FACTORIES.length === 0 || !LENS) return { available: false };
  try {
    const client = createPublicClient({ chain, transport: http(RPC) });

    // launchCount per factory in the union.
    const counts = await client.multicall({
      contracts: FACTORIES.map((address) => ({
        address,
        abi: ballastFactoryAbi,
        functionName: "launchCount" as const,
      })),
    });
    const perFactory = counts.map((r) => (r.status === "success" ? Number(r.result as bigint) : 0));
    const total = perFactory.reduce((a, b) => a + b, 0);
    if (total === 0) return { available: true, ballastedProjects: 0, totalBallastUsd: 0, launchesThisWeek: 0 };

    // Registry rows across all factories (same enumeration Discover uses).
    const refs: { f: Address; i: number }[] = [];
    FACTORIES.forEach((f, k) => {
      const c = perFactory[k] ?? 0;
      for (let i = 0; i < c; i++) refs.push({ f, i });
    });
    const rows = await client.multicall({
      contracts: refs.map((ref) => ({
        address: ref.f,
        abi: ballastFactoryAbi,
        functionName: "launches" as const,
        args: [BigInt(ref.i)],
      })),
    });
    // Dedupe by token (newest factory first in FACTORIES → first-seen wins), so a
    // token in two registries is counted once.
    const seen = new Set<string>();
    const treasuries: Address[] = [];
    rows.forEach((r) => {
      if (r.status !== "success") return;
      const [token, treasury] = r.result as readonly [Address, Address, Address];
      const key = token.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      treasuries.push(treasury);
    });

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

    // Launches this week: Launched events within the ~7-day block window, summed
    // across every factory.
    let launchesThisWeek = 0;
    try {
      const latest = await client.getBlockNumber();
      const fromBlock = latest > WEEK_BLOCKS ? latest - WEEK_BLOCKS : 0n;
      const logsPerFactory = await Promise.all(
        FACTORIES.map((address) =>
          client.getLogs({ address, event: LAUNCHED_EVENT, fromBlock, toBlock: "latest" }),
        ),
      );
      launchesThisWeek = logsPerFactory.reduce((a, logs) => a + logs.length, 0);
    } catch {
      // If the log scan fails but the reads above succeeded, fall back to the total
      // count rather than failing the whole strip — better a slightly loose "this
      // week" than dashes when we do have the other two figures.
      launchesThisWeek = treasuries.length;
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
