"use client";

import { useEffect, useState } from "react";
import { fetchIndexerStatus, isIndexerConfigured, type IndexerStatus } from "@/lib/indexer";

// Polls the indexer's liveness so indexer-sourced panels can degrade honestly:
// unconfigured → "needs indexer", down → "unreachable", delayed → "catching up".
// Chain-sourced figures (backing/price) don't use this — they read chain directly.
export function useIndexerStatus(): IndexerStatus {
  const [status, setStatus] = useState<IndexerStatus>({
    state: isIndexerConfigured ? "live" : "unconfigured",
  });

  useEffect(() => {
    if (!isIndexerConfigured) return;
    let cancelled = false;
    const tick = async () => {
      const s = await fetchIndexerStatus(Math.floor(Date.now() / 1000));
      if (!cancelled) setStatus(s);
    };
    void tick();
    const iv = setInterval(() => void tick(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  return status;
}
