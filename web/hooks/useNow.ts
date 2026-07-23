"use client";

import { useEffect, useState } from "react";

/**
 * Current unix seconds, set after mount (avoids SSR hydration mismatch) and
 * refreshed on an interval so freshness/countdowns stay live. Returns 0 until
 * mounted — callers should guard on that.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
