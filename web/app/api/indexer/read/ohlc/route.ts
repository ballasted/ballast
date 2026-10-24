import { NextResponse } from "next/server";
import { getTokenOhlc, type OhlcBucket } from "@/lib/indexer/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKETS: OhlcBucket[] = ["1m", "5m", "1h", "4h", "1D"];

// Public read: OHLC candles for a token/bucket. { available: false } when the
// indexer is unconfigured/empty so the client keeps its current source.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const bucketRaw = url.searchParams.get("bucket") ?? "1h";
  const limit = Number(url.searchParams.get("limit") ?? 1000);
  if (!token) return NextResponse.json({ available: false, error: "token required" }, { status: 400 });
  const bucket: OhlcBucket = (BUCKETS as string[]).includes(bucketRaw) ? (bucketRaw as OhlcBucket) : "1h";
  const candles = await getTokenOhlc(token, bucket, Number.isFinite(limit) ? limit : 1000);
  if (candles === null) return NextResponse.json({ available: false }, { headers: { "cache-control": "no-store" } });
  return NextResponse.json({ available: true, bucket, candles }, { headers: { "cache-control": "no-store" } });
}
