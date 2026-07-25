import { NextRequest } from "next/server";
import { GT_NETWORK, type MarketData, type MarketPool } from "@/lib/market";

// Server proxy to GeckoTerminal (Part E). Server-side so: the browser never hits
// a third-party API directly (CORS + one place to rate-limit), and responses are
// cached briefly to respect GeckoTerminal's ~30 req/min free tier. Returns a
// normalized MarketData; on any failure it returns available:false with a reason
// — the UI then degrades honestly, never showing a fabricated price.
export const runtime = "nodejs";
// Cache each token's market data for 30s (Vercel data cache). Keeps us well under
// the free-tier rate limit even under load.
export const revalidate = 30;

const GT = "https://api.geckoterminal.com/api/v2";
const TIMEOUT_MS = 8_000;

type GtPool = {
  attributes?: {
    address?: string;
    name?: string;
    volume_usd?: { h24?: string };
    reserve_in_usd?: string;
    price_change_percentage?: { h24?: string };
  };
  relationships?: { dex?: { data?: { id?: string } } };
};
type GtToken = {
  attributes?: { price_usd?: string; volume_usd?: { h24?: string } };
};

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.toLowerCase();
  if (!token || !/^0x[0-9a-f]{40}$/.test(token)) {
    return Response.json({ available: false, source: "GeckoTerminal", reason: "no-token", pools: [] } satisfies MarketData, {
      status: 400,
    });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const opts = { headers: { Accept: "application/json" }, signal: ac.signal, next: { revalidate } };
  try {
    const [tokRes, poolsRes] = await Promise.all([
      fetch(`${GT}/networks/${GT_NETWORK}/tokens/${token}`, opts),
      fetch(`${GT}/networks/${GT_NETWORK}/tokens/${token}/pools`, opts),
    ]);

    // 404 from GeckoTerminal = token/pool not indexed yet (e.g. below its ~$1k
    // liquidity floor, or too new). That's "not-indexed", not an error.
    if (tokRes.status === 404 || poolsRes.status === 404) {
      return Response.json(
        { available: false, source: "GeckoTerminal", reason: "not-indexed", pools: [], fetchedAt: Math.floor(Date.now() / 1000) } satisfies MarketData,
        { headers: { "cache-control": "s-maxage=30" } },
      );
    }
    if (!tokRes.ok && !poolsRes.ok) {
      return Response.json({ available: false, source: "GeckoTerminal", reason: "unreachable", pools: [] } satisfies MarketData, { status: 502 });
    }

    const tokJson = tokRes.ok ? ((await tokRes.json()) as { data?: GtToken }) : undefined;
    const poolsJson = poolsRes.ok ? ((await poolsRes.json()) as { data?: GtPool[] }) : undefined;

    const pools: MarketPool[] = (poolsJson?.data ?? [])
      .map((p) => ({
        address: p.attributes?.address ?? "",
        name: p.attributes?.name ?? "",
        dexId: p.relationships?.dex?.data?.id ?? "unknown",
        volume24hUsd: num(p.attributes?.volume_usd?.h24),
        reserveUsd: num(p.attributes?.reserve_in_usd),
        change24hPct: p.attributes?.price_change_percentage?.h24 !== undefined ? num(p.attributes.price_change_percentage.h24) : null,
      }))
      .filter((p) => p.address)
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
      .slice(0, 6);

    const top = pools[0];
    const priceUsd = tokJson?.data?.attributes?.price_usd !== undefined ? num(tokJson.data.attributes.price_usd) : undefined;
    const volume24hUsd = tokJson?.data?.attributes?.volume_usd?.h24 !== undefined ? num(tokJson.data.attributes.volume_usd.h24) : undefined;

    const data: MarketData = {
      available: pools.length > 0 || priceUsd !== undefined,
      source: "GeckoTerminal",
      reason: pools.length === 0 && priceUsd === undefined ? "not-indexed" : undefined,
      fetchedAt: Math.floor(Date.now() / 1000),
      priceUsd,
      volume24hUsd,
      change24hPct: top?.change24hPct ?? null,
      pools,
      top,
    };
    return Response.json(data, { headers: { "cache-control": "s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return Response.json(
      { available: false, source: "GeckoTerminal", reason: "unreachable", pools: [] } satisfies MarketData,
      { status: timedOut ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
