import { NextResponse } from "next/server";
import { getRecentTrades } from "@/lib/indexer/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public read: recent indexed trades for a token. { available: false } when the
// indexer is unconfigured/empty so the client keeps its current source.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (!token) return NextResponse.json({ available: false, error: "token required" }, { status: 400 });
  const trades = await getRecentTrades(token, Number.isFinite(limit) ? limit : 50);
  if (trades === null) return NextResponse.json({ available: false }, { headers: { "cache-control": "no-store" } });
  return NextResponse.json({ available: true, trades }, { headers: { "cache-control": "no-store" } });
}
