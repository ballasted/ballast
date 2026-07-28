import { listLaunches } from "@/lib/serverChain";
import { resolveTopPool, fetchPoolTrades, fetchPoolOhlcvDaily } from "@/lib/geckoServer";

// Protocol analytics time-series, from GeckoTerminal (volume + trades) aggregated
// across the launch union — NO indexer. Protocol TOTALS (total ballast, launches,
// ballasted share) are read client-side from chain via useProtocolStats and are NOT
// duplicated here, so the two never disagree. Only what GeckoTerminal can honestly
// supply lives here: 24h volume, 24h trades, and a daily-volume series (from OHLCV).
// Day-over-day trade history and prior-period trade counts are NOT available from
// the trades endpoint (short window), so we don't invent them.
export const runtime = "nodejs";
export const revalidate = 120;

const SCORE_CAP = 60;

type DayBar = { day: string; volumeUsd: number };
type AnalyticsPayload = {
  available: boolean;
  source: "GeckoTerminal";
  reason?: "unreachable";
  fetchedAt: number;
  volume24hUsd?: number;
  volumePrev24hUsd?: number; // prior day from the daily series, for a real delta
  trades24h?: number;
  daily: DayBar[];
};

function dayKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export async function GET() {
  const nowS = Math.floor(Date.now() / 1000);
  try {
    const launches = await listLaunches();
    if (launches.length === 0) {
      return Response.json(
        { available: true, source: "GeckoTerminal", fetchedAt: nowS, volume24hUsd: 0, trades24h: 0, daily: [] } satisfies AnalyticsPayload,
        { headers: { "cache-control": "s-maxage=120" } },
      );
    }
    const list = launches.slice(0, SCORE_CAP);
    const cutoff = nowS - 86_400;

    const perToken = await Promise.all(
      list.map(async (l) => {
        const token = l.token.toLowerCase();
        const pool = await resolveTopPool(token);
        if (!pool) return { volume24h: 0, trades24h: 0, daily: [] as Array<{ ts: number; volumeUsd: number }> };
        const [trades, daily] = await Promise.all([fetchPoolTrades(pool, token), fetchPoolOhlcvDaily(pool)]);
        const recent = trades.filter((t) => t.ts >= cutoff);
        const volume24h = recent.reduce((a, t) => a + t.volumeUsd, 0);
        return { volume24h, trades24h: recent.length, daily };
      }),
    );

    const volume24hUsd = perToken.reduce((a, t) => a + t.volume24h, 0);
    const trades24h = perToken.reduce((a, t) => a + t.trades24h, 0);

    // Sum daily volume across all pools into one protocol series.
    const byDay = new Map<string, number>();
    for (const t of perToken) {
      for (const d of t.daily) {
        const k = dayKey(d.ts);
        byDay.set(k, (byDay.get(k) ?? 0) + d.volumeUsd);
      }
    }
    const daily: DayBar[] = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, volumeUsd]) => ({ day, volumeUsd }));

    const volumePrev24hUsd = daily.length >= 2 ? daily[daily.length - 2]!.volumeUsd : undefined;

    return Response.json(
      { available: true, source: "GeckoTerminal", fetchedAt: nowS, volume24hUsd, volumePrev24hUsd, trades24h, daily } satisfies AnalyticsPayload,
      { headers: { "cache-control": "s-maxage=120, stale-while-revalidate=240" } },
    );
  } catch {
    return Response.json(
      { available: false, source: "GeckoTerminal", reason: "unreachable", fetchedAt: nowS, daily: [] } satisfies AnalyticsPayload,
      { status: 502 },
    );
  }
}
