// Client for the Ponder indexer. The app reads volume/holders/trades/charts from
// here over HTTP; backing/price are read from the CHAIN directly (never from the
// indexer), so those stay live even when this is down. Any figure sourced from the
// indexer must degrade to an honest label — never a stale or zero value — so this
// module's job is to report whether the indexer is live, delayed, or unreachable.

export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL ?? "";
export const isIndexerConfigured = INDEXER_URL.length > 0;

// Past this lag we call the indexer "delayed" — the UI then labels figures as
// catching-up rather than showing a value that's behind chain state.
const DELAY_THRESHOLD_SEC = 120;

export type IndexerState = "unconfigured" | "down" | "delayed" | "live";
export type IndexerStatus = { state: IndexerState; lastIndexedAt?: number };

// Best-effort extraction of the newest indexed block timestamp from Ponder's
// `_meta { status }` (shape varies by version), so lag detection survives upgrades.
function newestTimestamp(obj: unknown): number | undefined {
  let best: number | undefined;
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if ((k === "timestamp" || k === "blockTimestamp") && typeof val === "number") {
        best = best === undefined ? val : Math.max(best, val);
      } else if (typeof val === "object") {
        walk(val);
      }
    }
  };
  walk(obj);
  return best;
}

export async function fetchIndexerStatus(nowSec: number): Promise<IndexerStatus> {
  if (!isIndexerConfigured) return { state: "unconfigured" };
  try {
    const res = await fetch(INDEXER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ _meta { status } }" }),
      // Never serve a cached status.
      cache: "no-store",
    });
    if (!res.ok) return { state: "down" };
    const json = (await res.json()) as { data?: { _meta?: { status?: unknown } } };
    const ts = newestTimestamp(json?.data?._meta?.status);
    if (ts === undefined) return { state: "live" }; // responded but shape unknown — trust it's up
    const lag = nowSec - ts;
    return { state: lag > DELAY_THRESHOLD_SEC ? "delayed" : "live", lastIndexedAt: ts };
  } catch {
    return { state: "down" };
  }
}
