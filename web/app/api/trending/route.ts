import type { TrendingData, TrendingItem } from "@/lib/market";
import { listLaunches } from "@/lib/serverChain";
import { resolveTopPool, fetchPoolTrades } from "@/lib/geckoServer";

// Trending, built HONESTLY from 24h trade data — ranked by unique buyers first,
// then 24h volume, so two wallets wash-trading with each other can't buy the top
// slot (a single wallet counts once). Enumerates the launch union server-side (same
// source as Discover), aggregates per-token, and reports "thin" when there isn't
// enough real activity to rank — the UI then says so rather than showing a
// near-random order dressed as a ranking.
export const runtime = "nodejs";
export const revalidate = 60;

// Below this much aggregate 24h activity, ranking is noise — declare it thin.
const THIN_TOTAL_TRADES = 5;
// Cap the number of launches scored per refresh so a large registry can't fan out
// into a GeckoTerminal rate-limit storm. Anything skipped is surfaced, never hidden.
const SCORE_CAP = 60;

export async function GET() {
  const nowS = Math.floor(Date.now() / 1000);
  try {
    const launches = await listLaunches();
    if (launches.length === 0) {
      return Response.json(
        { available: true, source: "GeckoTerminal", fetchedAt: nowS, thin: true, items: [] } satisfies TrendingData,
        { headers: { "cache-control": "s-maxage=60" } },
      );
    }

    const capped = launches.length > SCORE_CAP ? launches.length - SCORE_CAP : undefined;
    const list = launches.slice(0, SCORE_CAP);
    const cutoff = nowS - 86_400;

    const items = await Promise.all(
      list.map(async (l): Promise<TrendingItem> => {
        const token = l.token.toLowerCase();
        const pool = await resolveTopPool(token);
        if (!pool) return { token, uniqueBuyers: 0, volume24hUsd: 0, trades24h: 0 };
        const trades = (await fetchPoolTrades(pool, token)).filter((t) => t.ts >= cutoff);
        const buyers = new Set<string>();
        let volume = 0;
        for (const t of trades) {
          volume += t.volumeUsd;
          if (t.kind === "buy" && t.wallet) buyers.add(t.wallet);
        }
        return { token, uniqueBuyers: buyers.size, volume24hUsd: volume, trades24h: trades.length };
      }),
    );

    const totalTrades = items.reduce((a, b) => a + b.trades24h, 0);
    const thin = totalTrades < THIN_TOTAL_TRADES;

    // Rank: unique buyers desc, then 24h volume desc. Both must be earned.
    items.sort((a, b) => b.uniqueBuyers - a.uniqueBuyers || b.volume24hUsd - a.volume24hUsd);

    const data: TrendingData = {
      available: true,
      source: "GeckoTerminal",
      fetchedAt: nowS,
      thin,
      capped,
      items,
    };
    return Response.json(data, { headers: { "cache-control": "s-maxage=60, stale-while-revalidate=120" } });
  } catch {
    return Response.json(
      { available: false, source: "GeckoTerminal", fetchedAt: nowS, thin: true, items: [] } satisfies TrendingData,
      { status: 502 },
    );
  }
}
