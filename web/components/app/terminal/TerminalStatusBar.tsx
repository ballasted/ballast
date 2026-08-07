"use client";

import { useEffect, useState } from "react";
import { useAccount, useBlockNumber, usePublicClient } from "wagmi";
import { activeChain, robinhoodChain } from "@/lib/chain";
import { formatEt } from "@/lib/marketHours";
import { cn } from "@/lib/cn";

const CHAIN_ID = activeChain.id;

// The thin bottom status bar: block · connection · RPC latency · last update. Every
// value is real — the block is watched live, latency is a measured round-trip, and
// "last update" is when this bar last re-read. No fabricated numbers.
export function TerminalStatusBar({ now }: { now: number }) {
  const { isConnected, chainId } = useAccount();
  const { data: block } = useBlockNumber({ chainId: CHAIN_ID, watch: true });
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [latencyMs, setLatencyMs] = useState<number | undefined>();

  // Measure a getBlockNumber round-trip periodically as a rough RPC-latency read.
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    const measure = async () => {
      const start = performance.now();
      try {
        await publicClient.getBlockNumber();
        if (!cancelled) setLatencyMs(Math.round(performance.now() - start));
      } catch {
        if (!cancelled) setLatencyMs(undefined);
      }
    };
    void measure();
    const id = setInterval(() => void measure(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [publicClient]);

  const wrongNetwork = isConnected && chainId !== robinhoodChain.id;
  const conn = !isConnected ? "not connected" : wrongNetwork ? "wrong network" : "connected";
  const connTone = !isConnected ? "bg-text-faint" : wrongNetwork ? "bg-warning" : "bg-green";
  const latTone = latencyMs === undefined ? "text-text-faint" : latencyMs < 400 ? "text-text-secondary" : "text-warning";

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-input border border-border px-3 py-1.5 text-[11px] tabular-nums text-text-faint">
      <span>
        Block <span className="text-text-secondary">{block !== undefined ? block.toString() : "…"}</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("h-1.5 w-1.5 rounded-full", connTone)} aria-hidden />
        {conn}
      </span>
      <span>
        RPC <span className={latTone}>{latencyMs !== undefined ? `${latencyMs}ms` : "—"}</span>
      </span>
      <span className="ml-auto">Updated {now > 0 ? formatEt(now) : "…"}</span>
    </div>
  );
}
