"use client";

import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, useBalance } from "wagmi";
import { useSwap } from "@/hooks/useSwap";
import { ConnectButton } from "@/components/app/ConnectButton";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { WETH_ADDRESS, isSwapConfigured } from "@/lib/contracts";
import { profile } from "@/lib/chainProfile";
import { activeChain } from "@/lib/chain";
import { cn } from "@/lib/cn";

type Side = "buy" | "sell";

const SLIPPAGE_PRESETS = [50, 100, 200] as const; // 0.5 / 1 / 2%
const WARN_BPS = 500; // >5% warns
const BLOCK_BPS = 1500; // >15% blocked

function fmt(v: bigint | undefined, dp = 6): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, 18));
  return n.toLocaleString("en", { maximumFractionDigits: dp });
}

// Gen-5 (Elysium) swap panel. Native HYPE (wrapped to WHYPE inside the router) on a
// buy; token → HYPE on a sell. Uses the minHopPriceX36 fork swap encoding (Elysium's
// router requires it, same as Robinhood) + extsload-based quoting, selected
// automatically by the active chain (see useSwap / lib/swap.ts).
export function SwapPanelV5({ token, symbol, hasPool }: { token: Address; symbol: string; hasPool: boolean }) {
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(100); // 1% default (tight)
  const [customSlip, setCustomSlip] = useState("");

  const { address: account } = useAccount();
  const { wrongNetwork, switchToActive, isSwitching, targetChainName } = useNetworkGuard();

  const s = useSwap(hasPool ? token : undefined, side, amount, slippageBps, WETH_ADDRESS);

  const nativeBal = useBalance({ address: account, chainId: activeChain.id });
  const tokenBal = useBalance({ address: account, token, chainId: activeChain.id });

  const nativeSym = profile.nativeSymbol; // HYPE
  const slipHigh = slippageBps > WARN_BPS;
  const slipBlocked = slippageBps > BLOCK_BPS;

  const canSwap = s.canSwap && !wrongNetwork && !slipBlocked;

  function applyCustomSlip(v: string) {
    setCustomSlip(v);
    const pct = Number(v);
    if (Number.isFinite(pct) && pct > 0) setSlippageBps(Math.round(pct * 100));
  }

  if (!isSwapConfigured) {
    return (
      <section className="card p-5 text-sm text-text-muted">Trading is not configured on this deployment.</section>
    );
  }

  return (
    <section className="card space-y-4 p-5">
      <div className="tabs">
        <button className={cn("tab", side === "buy" ? "tab-active" : "tab-idle")} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button className={cn("tab", side === "sell" ? "tab-active" : "tab-idle")} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>

      <label className="block space-y-1">
        <div className="flex justify-between text-xs text-text-muted">
          <span>You pay</span>
          <span>
            Balance:{" "}
            {side === "buy"
              ? `${fmt(nativeBal.data?.value, 4)} ${nativeSym}`
              : `${fmt(tokenBal.data?.value, 4)} ${symbol}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="input flex-1"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <span className="chip chip-neutral">{side === "buy" ? nativeSym : symbol}</span>
        </div>
      </label>

      <div className="flex items-center justify-between text-sm">
        <span className="text-text-muted">You receive (est.)</span>
        <span className="text-text-secondary">
          {fmt(s.quote)} {side === "buy" ? symbol : nativeSym}
        </span>
      </div>
      {s.quoteError ? <p className="text-xs text-warning">{s.quoteError}</p> : null}

      {/* slippage */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-text-muted">Slippage</span>
          {SLIPPAGE_PRESETS.map((bps) => (
            <button
              key={bps}
              className={cn("chip", slippageBps === bps && !customSlip ? "chip-accent" : "chip-neutral")}
              onClick={() => {
                setSlippageBps(bps);
                setCustomSlip("");
              }}
            >
              {bps / 100}%
            </button>
          ))}
          <input
            className="input w-16 py-1 text-right text-xs"
            inputMode="decimal"
            placeholder="%"
            value={customSlip}
            onChange={(e) => applyCustomSlip(e.target.value)}
          />
        </div>
        {slipBlocked ? (
          <p className="text-xs text-negative">Slippage above 15% is blocked.</p>
        ) : slipHigh ? (
          <p className="text-xs text-warning">High slippage — you may receive far less than shown.</p>
        ) : null}
      </div>

      {s.quote !== undefined ? (
        <div className="flex justify-between text-xs text-text-faint">
          <span>Minimum received</span>
          <span>
            {fmt(s.minOut)} {side === "buy" ? symbol : nativeSym}
          </span>
        </div>
      ) : null}

      {!account ? (
        <div className="flex justify-center">
          <ConnectButton />
        </div>
      ) : wrongNetwork ? (
        <button className="btn-primary w-full" onClick={() => void switchToActive()} disabled={isSwitching}>
          {isSwitching ? "Switching…" : `Switch to ${targetChainName}`}
        </button>
      ) : (
        <button
          className="btn-primary w-full"
          disabled={!canSwap || s.phase === "approving" || s.phase === "swapping"}
          onClick={() => void s.swap()}
        >
          {s.phase === "approving"
            ? "Approving…"
            : s.phase === "swapping"
              ? "Swapping…"
              : side === "buy"
                ? `Buy ${symbol}`
                : `Sell ${symbol}`}
        </button>
      )}

      {s.error ? <p className="text-xs text-negative">{s.error}</p> : null}
      {s.phase === "success" && s.txHash ? (
        <a
          className="block text-center text-xs text-green underline"
          href={`${activeChain.blockExplorers?.default.url}/tx/${s.txHash}`}
          target="_blank"
          rel="noreferrer"
        >
          Swap confirmed — view tx
        </a>
      ) : null}
    </section>
  );
}
