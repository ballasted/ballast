import { NextResponse } from "next/server";
import { cronAuthed } from "@/lib/indexer/auth";
import { isIndexerConfigured } from "@/lib/indexer/db";
import { serverClient } from "@/lib/serverChain";
import {
  DEFAULT_CURSOR,
  genesisBlock,
  getCursor,
  indexRange,
  indexerChainReady,
  snapshotTreasuries,
} from "@/lib/indexer/chain";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Incremental indexing from the cursor to chain head, BOUNDED per run so a single
// invocation never runs long. Vercel Cron authenticates via the CRON_SECRET Bearer
// header (see vercel.json). GET and POST both work (Vercel Cron issues GET).
//
// On a cold DB (no cursor yet) this advances at most MAX_BLOCKS_PER_RUN from
// genesis; use /api/indexer/backfill to catch history up quickly, then let the
// cron keep it live.
const MAX_BLOCKS_PER_RUN = 20_000n;

async function handle(req: Request) {
  if (!cronAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isIndexerConfigured()) return NextResponse.json({ skipped: "database not configured" });
  if (!indexerChainReady()) return NextResponse.json({ skipped: "chain addresses not configured" });

  let head: bigint;
  try {
    head = await serverClient().getBlockNumber();
  } catch {
    return NextResponse.json({ error: "rpc unreachable" }, { status: 502 });
  }

  const cursor = await getCursor(DEFAULT_CURSOR);
  const from = cursor === null ? genesisBlock() : cursor + 1n;
  if (from > head) {
    // Up to date — still refresh treasury snapshots best-effort.
    const snaps = await snapshotTreasuries().catch(() => 0);
    return NextResponse.json({ upToDate: true, cursor: cursor?.toString() ?? null, head: head.toString(), snapshots: snaps });
  }

  const to = from + MAX_BLOCKS_PER_RUN - 1n > head ? head : from + MAX_BLOCKS_PER_RUN - 1n;
  try {
    const res = await indexRange(from, to, DEFAULT_CURSOR);
    const moreWork = to < head;
    // Only snapshot treasuries once we're caught up, to keep caught-up runs cheap.
    const snaps = moreWork ? 0 : await snapshotTreasuries().catch(() => 0);
    return NextResponse.json({
      ok: true,
      fromBlock: res.fromBlock,
      toBlock: res.toBlock,
      counts: res.counts,
      moreWork,
      head: head.toString(),
      snapshots: snaps,
    });
  } catch (e) {
    console.error("[cron/index] failed", (e as Error).message);
    return NextResponse.json({ ok: false, error: "index failed" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
