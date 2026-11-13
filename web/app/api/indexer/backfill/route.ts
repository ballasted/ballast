import { NextResponse } from "next/server";
import { cronAuthed } from "@/lib/indexer/auth";
import { isIndexerConfigured } from "@/lib/indexer/db";
import { serverClient } from "@/lib/serverChain";
import { DEFAULT_CURSOR, genesisBlock, getCursor, indexRange, indexerChainReady, resetCursor } from "@/lib/indexer/chain";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Chunked, resumable historical backfill. Resumes from indexer_cursor and
// processes a BOUNDED number of blocks per call so each invocation stays well
// under the function timeout. Call it repeatedly (while moreWork === true) until
// it reports done.
//
// Query params:
//   blocks      blocks per iteration        (default 300000, max 9000000)
//   iterations  iterations per invocation   (default 1, max 10)
const DEFAULT_BLOCKS = 300_000n;
const MAX_BLOCKS = 9_000_000n;
const DEFAULT_ITERATIONS = 1;
const MAX_ITERATIONS = 10;

function bigParam(v: string | null, dflt: bigint, max: bigint): bigint {
  if (!v) return dflt;
  try {
    const n = BigInt(v);
    if (n <= 0n) return dflt;
    return n > max ? max : n;
  } catch {
    return dflt;
  }
}

export async function POST(req: Request) {
  if (!cronAuthed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isIndexerConfigured()) return NextResponse.json({ error: "database not configured" }, { status: 503 });
  if (!indexerChainReady()) return NextResponse.json({ error: "chain addresses not configured" }, { status: 503 });

  const url = new URL(req.url);
  // A distinct cursor name lets a manual catch-up run independently of the 2-min
  // cron (which uses DEFAULT_CURSOR), so the two never fight over one cursor row.
  // Rows are idempotent, so both populating the same tables is safe.
  const cursorName = (url.searchParams.get("cursor") || DEFAULT_CURSOR).slice(0, 40);
  const blocks = bigParam(url.searchParams.get("blocks"), DEFAULT_BLOCKS, MAX_BLOCKS);
  const iterRaw = Number(url.searchParams.get("iterations") ?? DEFAULT_ITERATIONS);
  const iterations = Number.isFinite(iterRaw) ? Math.min(Math.max(1, Math.floor(iterRaw)), MAX_ITERATIONS) : DEFAULT_ITERATIONS;

  let head: bigint;
  try {
    head = await serverClient().getBlockNumber();
  } catch {
    return NextResponse.json({ error: "rpc unreachable" }, { status: 502 });
  }

  // reset=1 restarts the backfill from genesis (after an indexing-logic fix).
  // Row inserts are idempotent, so a re-scan only fills gaps.
  if (url.searchParams.get("reset") === "1") await resetCursor(cursorName);

  const cursor = await getCursor(cursorName);
  let from = cursor === null ? genesisBlock() : cursor + 1n;
  if (from > head) {
    return NextResponse.json({ done: true, moreWork: false, cursor: cursor?.toString() ?? null, head: head.toString() });
  }

  let lastTo = from - 1n;
  const ranges: { from: string; to: string; counts: Record<string, number> }[] = [];
  try {
    for (let i = 0; i < iterations && from <= head; i++) {
      const to = from + blocks - 1n > head ? head : from + blocks - 1n;
      const res = await indexRange(from, to, cursorName);
      ranges.push({ from: res.fromBlock, to: res.toBlock, counts: res.counts });
      lastTo = to;
      from = to + 1n;
    }
  } catch (e) {
    console.error("[indexer/backfill] failed", (e as Error).message);
    return NextResponse.json(
      { ok: false, error: "backfill failed", cursor: (await getCursor(cursorName))?.toString() ?? null, ranges },
      { status: 500 },
    );
  }

  const moreWork = lastTo < head;
  return NextResponse.json({
    ok: true,
    done: !moreWork,
    moreWork,
    fromBlock: ranges[0]?.from ?? null,
    toBlock: lastTo.toString(),
    cursor: lastTo.toString(),
    head: head.toString(),
    ranges,
  });
}
