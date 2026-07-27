import type { Hash, PublicClient, TransactionReceipt } from "viem";

// Receipt polling that survives a flaky read path. viem's waitForTransactionReceipt
// rejects on a transport error, which on the rate-limited public RPC turns a
// perfectly-successful transaction into a red X + "Retry" — and Retry can deploy a
// duplicate. Instead we poll getTransactionReceipt with backoff, TREAT READ ERRORS
// AS "not yet" (keep polling), and only after a genuine wall-clock timeout report
// "lost" — outcome unknown, do NOT retry blindly, tell the user to check the
// explorer. A found receipt is authoritative: success or reverted.
export type ReceiptOutcome =
  | { status: "success"; receipt: TransactionReceipt }
  | { status: "reverted"; receipt: TransactionReceipt }
  | { status: "lost" }; // timed out — the tx may still have succeeded

export async function pollReceipt(
  client: PublicClient,
  hash: Hash,
  opts?: { maxMs?: number; onWaiting?: (elapsedMs: number) => void },
): Promise<ReceiptOutcome> {
  const maxMs = opts?.maxMs ?? 90_000;
  const start = Date.now();
  let delay = 800;
  // ~100ms blocks → a receipt should appear within a second or two; the backoff
  // exists to ride out transient RPC failures without hammering, not slow chains.
  while (Date.now() - start < maxMs) {
    try {
      const r = await client.getTransactionReceipt({ hash });
      if (r) return { status: r.status === "success" ? "success" : "reverted", receipt: r };
    } catch {
      // Not mined yet (TransactionReceiptNotFoundError) OR a transient read
      // failure — both mean "don't know yet". Keep polling; never give up on a
      // read error, that's the whole bug we're fixing.
    }
    opts?.onWaiting?.(Date.now() - start);
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(Math.round(delay * 1.4), 6_000);
  }
  return { status: "lost" };
}

// A mined-and-reverted receipt carries NO reason (status="reverted" is all the
// receipt says). To surface the actual error we replay the exact call with
// eth_call at the block it was mined in — a reverting call throws a viem error
// that carries the decoded `Error(string)` reason (e.g. TRANSFER_FROM_FAILED) or
// the raw revert data. We return that error (never throw) so the caller can feed
// it to decodeTxError; `undefined` means the replay unexpectedly did NOT revert.
export async function replayForRevert(client: PublicClient, hash: Hash): Promise<unknown> {
  try {
    const tx = await client.getTransaction({ hash });
    await client.call({
      account: tx.from,
      to: tx.to ?? undefined,
      data: tx.input,
      value: tx.value,
      gas: tx.gas,
      blockNumber: tx.blockNumber ?? undefined,
    });
    return undefined; // did not revert on replay — nothing to decode
  } catch (e) {
    return e;
  }
}
