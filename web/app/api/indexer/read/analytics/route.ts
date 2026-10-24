import { NextResponse } from "next/server";
import { getAnalyticsSeries } from "@/lib/indexer/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public read: daily protocol analytics series. { available: false } when the
// indexer is unconfigured/empty so the client keeps its current source
// (GeckoTerminal via /api/analytics).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days") ?? 30);
  const series = await getAnalyticsSeries(Number.isFinite(days) ? days : 30);
  if (series === null) return NextResponse.json({ available: false }, { headers: { "cache-control": "no-store" } });
  return NextResponse.json({ available: true, days: series }, { headers: { "cache-control": "no-store" } });
}
