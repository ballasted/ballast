import type { AbiEvent, Address, Log, PublicClient } from "viem";

// Generic getLogs backfill with a chunked fallback (no Ballast-specific
// knowledge). The precedent this follows is lib/heroStats.ts's server-side
// hero-stats scan, which already does a single unchunked getLogs call across a
// ~7-day (6,048,000 block) window successfully in production — so a single
// call across a smaller window is the expected common case; chunking only
// matters if the RPC rejects the range outright (a provider-specific cap, not
// something this chain enforces itself).
//
// Reports which of the two paths it took (and whether any chunk still failed)
// so the caller can label the result honestly rather than presenting a
// partially-failed backfill as if it were complete.
export type BackfillOutcome = {
  logs: Log[];
  status: "ok" | "partial" | "failed";
};

const FALLBACK_CHUNKS = 8;

export async function backfillLogs(
  client: PublicClient,
  params: { address: Address; event: AbiEvent; fromBlock: bigint; toBlock: bigint },
): Promise<BackfillOutcome> {
  try {
    const logs = await client.getLogs(params);
    return { logs, status: "ok" };
  } catch {
    return backfillChunked(client, params);
  }
}

async function backfillChunked(
  client: PublicClient,
  params: { address: Address; event: AbiEvent; fromBlock: bigint; toBlock: bigint },
): Promise<BackfillOutcome> {
  const { address, event, fromBlock, toBlock } = params;
  const span = toBlock - fromBlock;
  if (span <= 0n) return { logs: [], status: "ok" };

  const step = span / BigInt(FALLBACK_CHUNKS) + 1n;
  const logs: Log[] = [];
  let anyFailed = false;
  let anySucceeded = false;

  for (let from = fromBlock; from <= toBlock; from += step) {
    const to = from + step - 1n > toBlock ? toBlock : from + step - 1n;
    try {
      const part = await client.getLogs({ address, event, fromBlock: from, toBlock: to });
      logs.push(...part);
      anySucceeded = true;
    } catch {
      anyFailed = true;
    }
  }

  if (anyFailed && !anySucceeded) return { logs: [], status: "failed" };
  return { logs, status: anyFailed ? "partial" : "ok" };
}
