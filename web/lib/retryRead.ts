// Retries a flaky read-only RPC call with backoff — same "a transient
// transport failure is not a real error" principle as waitForReceipt.ts's
// receipt poll loop, applied to one-shot reads (getLogs/getBlockNumber)
// instead of a polling loop. Short backoff: reads should resolve in well
// under a second on this chain's ~100ms blocks, so this rides out a single
// RPC hiccup, not a real outage.
export async function retryRead<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 300): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        await new Promise((res) => setTimeout(res, baseDelayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}
