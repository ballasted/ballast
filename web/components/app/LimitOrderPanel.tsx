"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { formatUnits, type Address } from "viem";
import { ConnectButton } from "@/components/app/ConnectButton";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useLimitOrders, type LimitSide, type LiveOrder } from "@/hooks/useLimitOrders";
import { profile } from "@/lib/chainProfile";
import { activeChain } from "@/lib/chain";

// Gen-5 (Elysium) on-chain limit orders via BallastHookV5. Place a single-tick range
// order that fills as price crosses it; cancel an unfilled one; withdraw a filled one.
export function LimitOrderPanel({ token, symbol }: { token: Address; symbol?: string }) {
  const { address: account } = useAccount();
  const { wrongNetwork, switchToActive, isSwitching, targetChainName } = useNetworkGuard();
  const lo = useLimitOrders(token);

  const [side, setSide] = useState<LimitSide>("buy");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");

  const tkr = symbol || "token";
  const inputSymbol = side === "sell" ? tkr : profile.quoteSymbol;
  const explorer = activeChain.blockExplorers?.default.url;
  const busy = lo.phase === "approving" || lo.phase === "placing" || lo.phase === "cancelling" || lo.phase === "withdrawing";

  return (
    <section className="card space-y-4 p-5">
      <div className="flex items-center justify-between">
        <div className="section-label">Limit order</div>
        <span className="chip chip-accent">{profile.label}</span>
      </div>

      {/* side */}
      <div className="tabs">
        <button
          className={`tab ${side === "buy" ? "tab-active" : ""}`}
          onClick={() => setSide("buy")}
        >
          Buy
        </button>
        <button
          className={`tab ${side === "sell" ? "tab-active" : ""}`}
          onClick={() => setSide("sell")}
        >
          Sell
        </button>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">Price ({profile.quoteSymbol} per {tkr})</span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="0.0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-text-muted">
            Amount to {side === "sell" ? "sell" : "spend"} ({inputSymbol})
          </span>
          <input
            className="input"
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
      </div>

      <p className="note note-neutral text-xs">
        {side === "buy"
          ? `Fills when the price falls to your target. Your ${profile.quoteSymbol} is held on-chain until then.`
          : `Fills when the price rises to your target. Your ${tkr} is held on-chain until then.`}
      </p>

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
          disabled={busy || !price || !amount}
          onClick={() => void lo.place(side, price, amount)}
        >
          {lo.phase === "approving"
            ? "Approving…"
            : lo.phase === "placing"
              ? "Placing…"
              : "Place limit order"}
        </button>
      )}

      {lo.error ? <p className="text-xs text-negative">{lo.error}</p> : null}

      {/* my orders */}
      {lo.orders.length > 0 ? (
        <div className="space-y-2 border-t border-hairline pt-3">
          <div className="section-label">My orders</div>
          {lo.orders.map((o) => (
            <OrderRow key={`${o.hook}-${o.epoch}`} order={o} tkr={tkr} busy={busy} lo={lo} explorer={explorer} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function OrderRow({
  order,
  tkr,
  busy,
  lo,
  explorer,
}: {
  order: LiveOrder;
  tkr: string;
  busy: boolean;
  lo: ReturnType<typeof useLimitOrders>;
  explorer?: string;
}) {
  const stateLabel = order.state === "filled" ? "Filled" : order.state === "open" ? "Open" : "Closed";
  const stateChip =
    order.state === "filled" ? "chip-accent" : order.state === "open" ? "chip-neutral" : "chip-warning";
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex flex-col">
        <span className="text-text-secondary">
          {order.side === "sell" ? "Sell" : "Buy"} {tkr} @ {order.priceLabel}
        </span>
        <span className="text-xs text-text-faint">
          liquidity {formatUnits(order.remainingLiquidity, 0)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`chip ${stateChip}`}>{stateLabel}</span>
        {order.state === "open" ? (
          <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} onClick={() => void lo.cancel(order)}>
            Cancel
          </button>
        ) : null}
        {order.state === "filled" ? (
          <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} onClick={() => void lo.withdraw(order)}>
            Withdraw
          </button>
        ) : null}
        {lo.txHash && explorer ? (
          <a className="text-xs text-text-faint underline" href={`${explorer}/tx/${lo.txHash}`} target="_blank" rel="noreferrer">
            tx
          </a>
        ) : null}
      </div>
    </div>
  );
}
