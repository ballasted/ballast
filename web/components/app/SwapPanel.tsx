"use client";

import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { useSwap } from "@/hooks/useSwap";
import { ConnectButton } from "@/components/app/ConnectButton";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { activeChain } from "@/lib/chain";
import { isSwapConfigured } from "@/lib/contracts";
import { cn } from "@/lib/cn";
import { useAccount } from "wagmi";

type Side = "buy" | "sell";

function fmt(v: bigint | undefined, dp = 6): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, 18));
  return n.toLocaleString("en", { maximumFractionDigits: dp });
}

const SLIPPAGE_OPTIONS = [50, 100, 200] as const;

export function SwapPanel({
  token,
  symbol,
  hasPool,
  spotPriceWeth,
}: {
  token: Address;
  symbol: string;
  hasPool: boolean;
  spotPriceWeth?: bigint; // WETH per token, 1e18 — pool mid, for price impact
}) {
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const { address: account } = useAccount();
  const { wrongNetwork } = useNetworkGuard();
  const s = useSwap(hasPool ? token : undefined, side, amount, slippageBps);

  if (!isSwapConfigured) {
    return (
      <div className="card p-4 text-sm text-text-muted">
        Trading needs the pool addresses (hook, router, state view). Set them after deploy to enable Buy/Sell.
      </div>
    );
  }
  if (!hasPool) {
    return (
      <div className="card p-4 text-sm text-text-muted">
        No pool yet — this token hasn&apos;t graduated, so there&apos;s nothing to trade against. Buy/Sell activate the
        moment its pool is seeded.
      </div>
    );
  }

  const inLabel = side === "buy" ? "WETH" : symbol;
  const outLabel = side === "buy" ? symbol : "WETH";
  const busy = s.phase === "approving" || s.phase === "swapping";

  // Price impact vs the pool mid: compare the quote's effective price to spot.
  //   buy  → WETH-in / token-out is the paid price; impact = paid/spot − 1
  //   sell → WETH-out / token-in is the received price; impact = 1 − received/spot
  let priceImpactPct: number | undefined;
  if (spotPriceWeth && spotPriceWeth > 0n && s.quote !== undefined && s.quote > 0n && s.amountIn > 0n) {
    const spot = Number(spotPriceWeth) / 1e18;
    if (side === "buy") {
      const paid = Number(s.amountIn) / Number(s.quote);
      priceImpactPct = (paid / spot - 1) * 100;
    } else {
      const received = Number(s.quote) / Number(s.amountIn);
      priceImpactPct = (1 - received / spot) * 100;
    }
  }
  const highImpact = priceImpactPct !== undefined && priceImpactPct > 5;

  return (
    <div className="card p-4">
      {/* Buy / Sell — no motion beyond the underline (Part 3). */}
      <div className="grid grid-cols-2 gap-2 rounded-input border border-border p-1">
        {(["buy", "sell"] as const).map((sd) => (
          <button
            key={sd}
            onClick={() => setSide(sd)}
            className={cn(
              "rounded px-3 py-2 text-sm font-semibold capitalize",
              side === sd
                ? sd === "buy"
                  ? "bg-green-bg text-green"
                  : "bg-warning-bg text-warning"
                : "text-text-muted hover:text-text-secondary",
            )}
          >
            {sd}
          </button>
        ))}
      </div>

      <label className="field-label mt-4">You pay ({inLabel})</label>
      <input
        className="input"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder="0.0"
        disabled={busy}
      />

      <div className="mt-3 flex items-center justify-between text-sm">
        <span className="text-text-muted">You receive ({outLabel})</span>
        <span className="figure-primary">
          {s.phase === "quoting" ? "…" : fmt(s.quote)}
        </span>
      </div>
      {s.quote !== undefined && (
        <>
          {priceImpactPct !== undefined && (
            <div className="mt-1 flex items-center justify-between text-xs">
              <span className="text-text-faint">Price impact</span>
              <span className={cn("tabular-nums", highImpact ? "text-warning" : "text-text-muted")}>
                {priceImpactPct < 0.01 ? "<0.01" : priceImpactPct.toFixed(2)}%
              </span>
            </div>
          )}
          <div className="mt-1 flex items-center justify-between text-xs text-text-faint">
            <span>Minimum after {slippageBps / 100}% slippage</span>
            <span className="tabular-nums">{fmt(s.minOut)}</span>
          </div>
        </>
      )}
      {s.quoteError && amount && (
        <p className="mt-2 text-xs text-warning">Couldn&apos;t quote this size against current liquidity.</p>
      )}

      {/* Slippage tolerance */}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-text-faint">Slippage tolerance</span>
        <div className="flex gap-1">
          {SLIPPAGE_OPTIONS.map((bps) => (
            <button
              key={bps}
              onClick={() => setSlippageBps(bps)}
              className={cn(
                "rounded px-2 py-1 text-xs tabular-nums transition-colors",
                slippageBps === bps ? "bg-green-bg text-green" : "text-text-muted hover:text-text-secondary",
              )}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {!account ? (
          <div className="flex justify-center"><ConnectButton /></div>
        ) : s.phase === "success" ? (
          <div className="space-y-2 text-center">
            <p className="text-sm text-green">Swap confirmed.</p>
            {s.txHash && (
              <a
                className="text-xs text-text-faint hover:text-text-secondary"
                href={`${activeChain.blockExplorers.default.url}/tx/${s.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View on Blockscout ↗
              </a>
            )}
            <button className="btn-secondary w-full" onClick={() => { setAmount(""); s.reset(); }}>
              Trade again
            </button>
          </div>
        ) : (
          <button
            className={cn("w-full", side === "buy" ? "btn-primary" : "btn-secondary")}
            disabled={!s.canSwap || busy || wrongNetwork}
            onClick={s.swap}
          >
            {wrongNetwork
              ? "Switch to Robinhood Chain"
              : s.phase === "approving"
                ? "Approving…"
                : s.phase === "swapping"
                  ? "Swapping…"
                  : side === "buy"
                    ? `Buy ${symbol}`
                    : `Sell ${symbol}`}
          </button>
        )}
        {s.error && <p className="mt-2 text-center text-xs text-negative">{s.error}</p>}
      </div>
    </div>
  );
}
