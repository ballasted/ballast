import { NextResponse } from "next/server";
import { getDiscoverStats } from "@/lib/indexer/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public read: protocol-wide Discover stats. { available: false } when the indexer
// is unconfigured/empty so the client keeps its current source.
export async function GET() {
  const stats = await getDiscoverStats();
  if (stats === null) return NextResponse.json({ available: false }, { headers: { "cache-control": "no-store" } });
  return NextResponse.json({ available: true, stats }, { headers: { "cache-control": "no-store" } });
}
