import { NextRequest } from "next/server";
import type { TradesData } from "@/lib/market";
import { resolveTopPool, fetchPoolTrades } from "@/lib/geckoServer";

// Server proxy to GeckoTerminal for a token's recent trades. Resolves the token's
// deepest pool, then reads that pool's trade feed and normalizes direction from the
// token addresses. Cached; degrades to available:false with a reason on failure.
export const runtime = "nodejs";
export const revalidate = 30;

const MAX = 50;

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.toLowerCase();
  if (!token || !/^0x[0-9a-f]{40}$/.test(token)) {
    return Response.json(
      { available: false, source: "GeckoTerminal", reason: "no-token", trades: [] } satisfies TradesData,
      { status: 400 },
    );
  }

  try {
    const pool = await resolveTopPool(token);
    if (!pool) {
      return Response.json(
        {
          available: false,
          source: "GeckoTerminal",
          reason: "not-indexed",
          trades: [],
          fetchedAt: Math.floor(Date.now() / 1000),
        } satisfies TradesData,
        { headers: { "cache-control": "s-maxage=30" } },
      );
    }
    const trades = (await fetchPoolTrades(pool, token)).slice(0, MAX);
    const data: TradesData = {
      available: true,
      source: "GeckoTerminal",
      fetchedAt: Math.floor(Date.now() / 1000),
      pool,
      trades,
    };
    return Response.json(data, { headers: { "cache-control": "s-maxage=30, stale-while-revalidate=60" } });
  } catch {
    return Response.json(
      { available: false, source: "GeckoTerminal", reason: "unreachable", trades: [] } satisfies TradesData,
      { status: 502 },
    );
  }
}
