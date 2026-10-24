import { NextResponse } from "next/server";
import { getTokenHolders } from "@/lib/indexer/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public read: holder distribution for a token (dead + zero addresses excluded).
// { available: false } when the indexer is unconfigured/empty so the client keeps
// its current source (Blockscout).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const limit = Number(url.searchParams.get("limit") ?? 100);
  if (!token) return NextResponse.json({ available: false, error: "token required" }, { status: 400 });
  const result = await getTokenHolders(token, Number.isFinite(limit) ? limit : 100);
  if (result === null) return NextResponse.json({ available: false }, { headers: { "cache-control": "no-store" } });
  return NextResponse.json({ available: true, ...result }, { headers: { "cache-control": "no-store" } });
}
