import { NextRequest } from "next/server";
import { GT_NETWORK, TIMEFRAMES, DEFAULT_TIMEFRAME, type OhlcvData, type Timeframe } from "@/lib/market";
import { resolveTopPool, fetchPoolOhlcv } from "@/lib/geckoServer";

// Server proxy to GeckoTerminal's OHLCV endpoint, mirroring /api/market: the browser
// never hits GeckoTerminal directly (CORS + one place to rate-limit), responses are
// cached briefly, and on any failure we return available:false with a reason so the
// chart degrades honestly rather than drawing a fabricated series. GT_NETWORK is the
// same source used for trades and volume — never backing valuation, which stays
// on-chain via BackingLens.
export const runtime = "nodejs";
export const revalidate = 30;

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.toLowerCase();
  const tfParam = req.nextUrl.searchParams.get("tf");
  const tf = TIMEFRAMES.find((t) => t.key === tfParam) ?? TIMEFRAMES.find((t) => t.key === DEFAULT_TIMEFRAME)!;

  if (!token || !/^0x[0-9a-f]{40}$/.test(token)) {
    return Response.json(
      { available: false, source: "GeckoTerminal", reason: "no-token", timeframe: tf.key, candles: [] } satisfies OhlcvData,
      { status: 400 },
    );
  }

  try {
    // OHLCV is per-pool, so resolve the deepest pool first (GT orders by relevance).
    const pool = await resolveTopPool(token);
    if (!pool) {
      return Response.json(
        {
          available: false,
          source: "GeckoTerminal",
          reason: "not-indexed",
          timeframe: tf.key as Timeframe,
          candles: [],
          fetchedAt: Math.floor(Date.now() / 1000),
        } satisfies OhlcvData,
        { headers: { "cache-control": "s-maxage=30" } },
      );
    }

    const candles = await fetchPoolOhlcv(pool, tf.gt, tf.aggregate);
    const data: OhlcvData = {
      available: candles.length > 0,
      source: "GeckoTerminal",
      reason: candles.length === 0 ? "not-indexed" : undefined,
      fetchedAt: Math.floor(Date.now() / 1000),
      pool,
      timeframe: tf.key,
      candles,
    };
    return Response.json(data, { headers: { "cache-control": "s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return Response.json(
      { available: false, source: "GeckoTerminal", reason: "unreachable", timeframe: tf.key, candles: [] } satisfies OhlcvData,
      { status: timedOut ? 504 : 502 },
    );
  }
}
