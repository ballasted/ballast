"use client";

import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, useBalance, useReadContract, useGasPrice } from "wagmi";
import { useSwap, type SwapPhase } from "@/hooks/useSwap";
import { useTokenQuotePools } from "@/hooks/useTokenQuotePools";
import { ConnectButton } from "@/components/app/ConnectButton";
import { ActingAs } from "@/components/app/ActingAs";
import { AssetDisc } from "@/components/app/AssetDisc";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { activeChain } from "@/lib/chain";
import { isSwapConfigured } from "@/lib/contracts";
import { erc20Abi } from "@/lib/abis";
import { cn } from "@/lib/cn";

type Side = "buy" | "sell";

const SLIPPAGE_PRESETS = [50, 100, 200] as const; // 0.5 / 1 / 2%
const WARN_BPS = 500; // >5% warns
const BLOCK_BPS = 1500; // >15% is blocked
// Leave a little native ETH for gas when sizing a buy to a percentage of balance,
// so "Max" never produces an amount that can't also pay for the transaction.
const GAS_RESERVE = 5n * 10n ** 14n; // 0.0005 ETH
// Rough gas units for the single execute() call, per side — for a fee ESTIMATE
// only (the wallet shows the exact fee at signing).
const EST_GAS: Record<Side, bigint> = { buy: 320_000n, sell: 400_000n };

function fmt(v: bigint | undefined, dp = 6): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, 18));
  return n.toLocaleString("en", { maximumFractionDigits: dp });
}

export function SwapPanel({
  token,
  symbol,
  hasPool,
  spotPriceWeth,
  dense = false,
}: {
  token: Address;
  symbol: string;
  hasPool: boolean;
  spotPriceWeth?: bigint; // WETH per token, 1e18 — pool mid, for price impact
  dense?: boolean; // tighter padding for the terminal rail
}) {
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [customSlip, setCustomSlip] = useState("");
  const [selectedQuote, setSelectedQuote] = useState<Address | undefined>(undefined);
  const { address: account } = useAccount();
  const { wrongNetwork } = useNetworkGuard();

  // A launch may pair its token against WETH and/or up to 4 GREEN quote assets
  // (SGOV/NVDA/SPY today) — each its own live pool. Default to WETH (the
  // familiar "pay ETH" flow, unchanged for every single-pool token) when
  // present, else whichever pool actually exists.
  const { options: quotePools } = useTokenQuotePools(hasPool ? token : undefined);
  const activeQuote =
    quotePools.find((o) => o.quoteAsset === selectedQuote) ?? quotePools.find((o) => o.isWeth) ?? quotePools[0];
  const isWethQuote = activeQuote?.isWeth ?? true; // assume WETH until pools resolve — zero flicker for the common case

  const s = useSwap(hasPool ? token : undefined, side, amount, slippageBps, activeQuote?.quoteAsset);

  // Balances for the active input leg: native ETH on a WETH buy, the quote
  // asset's ERC-20 on a non-WETH buy (e.g. paying in NVDA), the token on a sell.
  const ethBal = useBalance({
    address: account,
    chainId: activeChain.id,
    query: { enabled: Boolean(account) && hasPool && side === "buy" && isWethQuote, refetchInterval: 15_000 },
  });
  const quoteAssetBal = useReadContract({
    address: activeQuote?.quoteAsset,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: activeChain.id,
    query: { enabled: Boolean(account) && hasPool && side === "buy" && !isWethQuote && Boolean(activeQuote) },
  });
  const tokenBal = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: activeChain.id,
    query: { enabled: Boolean(account) && hasPool && side === "sell" },
  });
  const balance =
    side === "buy"
      ? isWethQuote
        ? ethBal.data?.value
        : (quoteAssetBal.data as bigint | undefined)
      : (tokenBal.data as bigint | undefined);
  const gasPrice = useGasPrice({ chainId: activeChain.id, query: { enabled: hasPool } });

  if (!isSwapConfigured) {
    return (
      <div className="card p-5 text-sm text-text-muted">
        Trading needs the pool addresses (hook, router, state view) — set them after deploy to enable Buy/Sell.
      </div>
    );
  }
  if (!hasPool) {
    return (
      <div className="card p-5 text-sm text-text-muted">
        No pool yet — nothing to trade against until it graduates. Buy/Sell activate the moment the pool is seeded.
      </div>
    );
  }

  // Against WETH, buys spend native ETH and sells receive native ETH — the
  // wrap/unwrap happens inside the router, so the user only ever sees ETH
  // (labelling the leg "WETH" would be misleading). Against any other quote
  // asset (SGOV/NVDA/SPY), neither leg is ETH — the user pays/receives that
  // ERC-20 directly, so its own symbol is shown instead.
  const quoteSym = isWethQuote ? "ETH" : activeQuote?.symbol || "…";
  const inSym = side === "buy" ? quoteSym : symbol;
  const outSym = side === "buy" ? symbol : quoteSym;
  const busy = s.phase === "approving" || s.phase === "swapping";

  const insufficient = balance !== undefined && s.amountIn > 0n && s.amountIn > balance;
  const slipWarn = slippageBps > WARN_BPS && slippageBps <= BLOCK_BPS;
  const slipBlocked = slippageBps > BLOCK_BPS;

  // Price impact vs the pool mid: compare the quote's effective price to spot.
  // spotPriceWeth (from useBacking, WETH-only) only applies when trading against
  // WETH; any other active quote asset uses its OWN pool's mid from useTokenQuotePools.
  const spotPrice = isWethQuote ? spotPriceWeth : activeQuote?.marketPriceInQuote;
  let priceImpactPct: number | undefined;
  if (spotPrice && spotPrice > 0n && s.quote !== undefined && s.quote > 0n && s.amountIn > 0n) {
    const spot = Number(spotPrice) / 1e18;
    if (side === "buy") {
      priceImpactPct = (Number(s.amountIn) / Number(s.quote) / spot - 1) * 100;
    } else {
      priceImpactPct = (1 - Number(s.quote) / Number(s.amountIn) / spot) * 100;
    }
  }
  const highImpact = priceImpactPct !== undefined && priceImpactPct > 5;

  const feeWei = gasPrice.data !== undefined ? gasPrice.data * EST_GAS[side] : undefined;

  function setSize(pct: number) {
    if (balance === undefined) return;
    const usable = side === "buy" ? (balance > GAS_RESERVE ? balance - GAS_RESERVE : 0n) : balance;
    const v = (usable * BigInt(Math.round(pct))) / 100n;
    setAmount(v === 0n ? "" : formatUnits(v, 18));
  }

  function flipSide() {
    setSide((p) => (p === "buy" ? "sell" : "buy"));
    setAmount(""); // the pay unit changes on flip
    s.reset();
  }

  function applyCustomSlip(v: string) {
    setCustomSlip(v);
    const pct = parseFloat(v);
    if (Number.isFinite(pct) && pct > 0) setSlippageBps(Math.round(pct * 100));
  }

  return (
    <div className={cn("card", dense ? "p-4" : "p-5")}>
      {/* Buy / Sell segmented control */}
      <div className="grid grid-cols-2 gap-2 rounded-input border border-border p-1">
        {(["buy", "sell"] as const).map((sd) => (
          <button
            key={sd}
            onClick={() => sd !== side && flipSide()}
            className={cn(
              "tab-segment capitalize",
              side === sd
                ? sd === "buy"
                  ? "bg-green-bg text-green"
                  : "bg-warning-bg text-warning"
                : "tab-idle",
            )}
          >
            {sd}
          </button>
        ))}
      </div>

      {/* Quote-asset picker — only shown once a token has more than one live
          pool (e.g. graduated against both WETH and NVDA). A single-pool token
          never renders this row, so the default WETH flow is pixel-identical
          to before. */}
      {quotePools.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {quotePools.map((o) => (
            <button
              key={o.quoteAsset}
              onClick={() => setSelectedQuote(o.quoteAsset)}
              disabled={busy}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40",
                o.quoteAsset === activeQuote?.quoteAsset
                  ? "border-green bg-green-bg text-green"
                  : "border-border text-text-muted hover:text-text-secondary",
              )}
            >
              <AssetDisc
                symbol={o.isWeth ? "WETH" : o.symbol}
                size={16}
                identity={{ status: "recognized", symbol: o.isWeth ? "WETH" : o.symbol }}
              />
              {o.isWeth ? "ETH" : o.symbol}
            </button>
          ))}
        </div>
      )}

      {/* Pay */}
      <div className="mt-4 rounded-input border border-border bg-bg p-3">
        <div className="flex items-center justify-between">
          <span className="field-label mb-0 text-text-faint">You pay</span>
          <AssetChip sym={inSym} />
        </div>
        <input
          className="mt-1 w-full bg-transparent text-2xl font-semibold tabular-nums text-text-primary placeholder:text-text-faint focus:outline-none"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.0"
          disabled={busy}
        />
        <div className="mt-1 flex items-center justify-between text-xs text-text-faint">
          <span>
            Balance: {balance !== undefined ? fmt(balance, 4) : "…"} {inSym}
          </span>
          <div className="flex gap-1">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                onClick={() => setSize(pct)}
                disabled={busy || balance === undefined}
                className="rounded bg-border px-1.5 py-0.5 text-[11px] tabular-nums text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Pair-swap arrow on the divider — rotates 180° on tap (Phase 4). */}
      <div className="relative flex h-0 items-center justify-center">
        <button
          onClick={flipSide}
          aria-label="Switch buy and sell"
          disabled={busy}
          className={cn(
            "z-10 -my-2 grid h-8 w-8 place-items-center rounded-full border border-border bg-card text-text-secondary transition-transform duration-200 ease-out hover:text-text-primary disabled:opacity-40 motion-reduce:transition-none",
            side === "sell" && "rotate-180",
          )}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 5v14M12 19l-5-5M12 19l5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Receive (read-only) */}
      <div className="rounded-input border border-border bg-bg p-3">
        <div className="flex items-center justify-between">
          <span className="field-label mb-0 text-text-faint">You receive</span>
          <AssetChip sym={outSym} />
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">
          {/* Crossfade the figure as the quote updates (Phase 4). */}
          {s.phase === "quoting" ? (
            <span className="text-text-faint">…</span>
          ) : (
            <span key={fmt(s.quote)} className="anim-fade inline-block">
              {fmt(s.quote)}
            </span>
          )}
        </div>
        {/* This field is display-only — you enter what you PAY, never a target
            output. Sells are exact-input only in the contracts (an exact-output
            sell reverts SellExactOutNotSupported), so we say so here rather than
            let anyone try to pin the received amount and hit a raw revert. */}
        {side === "sell" && (
          <p className="mt-1 text-[11px] text-text-faint">
            Estimated. Sells are exact-input, so the output isn&apos;t fixed — the least you&apos;ll accept is the
            slippage minimum below.
          </p>
        )}
      </div>

      {s.quoteError && amount && (
        <p className="mt-2 text-xs text-warning">Couldn&apos;t quote this size against current liquidity.</p>
      )}

      {/* Slippage tolerance — presets + custom, default 1% */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-faint">Slippage tolerance</span>
          <div className="flex items-center gap-1">
            {SLIPPAGE_PRESETS.map((bps) => (
              <button
                key={bps}
                onClick={() => {
                  setSlippageBps(bps);
                  setCustomSlip("");
                }}
                className={cn(
                  "rounded px-2 py-1 text-xs tabular-nums transition-colors",
                  slippageBps === bps && !customSlip
                    ? "bg-green-bg text-green"
                    : "text-text-muted hover:text-text-secondary",
                )}
              >
                {bps / 100}%
              </button>
            ))}
            <div className="flex items-center rounded border border-border px-1.5 py-0.5">
              <input
                className="w-9 bg-transparent text-right text-xs tabular-nums text-text-primary placeholder:text-text-faint focus:outline-none"
                inputMode="decimal"
                value={customSlip}
                onChange={(e) => applyCustomSlip(e.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="custom"
              />
              <span className="text-xs text-text-faint">%</span>
            </div>
          </div>
        </div>
        {(slipWarn || slipBlocked) && (
          <p className={cn("mt-1.5 text-xs", slipBlocked ? "text-negative" : "text-warning")}>
            {slipBlocked
              ? "Over 15% is blocked. Pools here are thin — this size gives too much to price movement. Split it smaller."
              : "Above 5%. Pools here are thin, so even a modest order can move the price — you may get noticeably less than quoted."}
          </p>
        )}
      </div>

      {/* Detail rows — each labelled with what it means, not just a number. */}
      {s.quote !== undefined && (
        <div className="mt-4 space-y-1.5 border-t border-border pt-3">
          {priceImpactPct !== undefined && (
            <DetailRow
              label="Price impact"
              hint="How much your own trade moves the pool price"
              value={priceImpactPct < 0.01 ? "<0.01%" : `${priceImpactPct.toFixed(2)}%`}
              tone={highImpact ? "warning" : undefined}
            />
          )}
          <DetailRow
            label="Minimum received"
            hint={`The least you'll accept after ${(slippageBps / 100).toFixed(slippageBps % 100 ? 2 : 0)}% slippage`}
            value={`${fmt(s.minOut)} ${outSym}`}
          />
          <DetailRow
            label="Network fee"
            hint="Estimated gas in ETH; wallet shows the exact amount at signing. Priority fees do nothing here."
            value={feeWei !== undefined ? `≈ ${fmt(feeWei, 6)} ETH` : "shown at signing"}
          />
          <DetailRow
            label="Route"
            hint={isWethQuote ? "The venue, and how ETH is wrapped inside the swap." : "The venue — a direct pool, no wrap involved."}
            value={
              isWethQuote
                ? side === "buy"
                  ? "Uniswap v4 · ETH wrapped in-route"
                  : "Uniswap v4 · unwrapped to ETH"
                : `Uniswap v4 · direct ${quoteSym} pool`
            }
          />
          {highImpact && (
            <p className="pt-1 text-xs text-warning">
              Your order moves the price {priceImpactPct!.toFixed(1)}%. Liquidity is thin by design; a smaller order, or
              splitting it, keeps more of the quote.
            </p>
          )}
        </div>
      )}

      {/* Approval story — ETH-wrapped buys against WETH need no approval at all;
          every other leg (a WETH sell, or EITHER side against a non-WETH quote
          asset like NVDA/SPY/SGOV) pulls its input via Permit2, so it gets the
          explicit two-step flow. */}
      {side === "buy" && isWethQuote ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-green">
          <span aria-hidden>✓</span> No approval needed — ETH is wrapped inside the swap.
        </p>
      ) : (
        <ApprovalSteps phase={s.phase} paySymbol={inSym} receiveSymbol={outSym} unwrapsToEth={side === "sell" && isWethQuote} />
      )}

      {/* Action */}
      <div className="mt-4">
        {account && <ActingAs className="mb-2 justify-end" />}
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
            disabled={
              busy || wrongNetwork || slipBlocked || insufficient || s.amountIn === 0n || s.quote === undefined
            }
            onClick={s.swap}
          >
            <span key={buttonLabel(s.phase, { side, symbol, paySymbol: inSym, wrongNetwork, insufficient, slipBlocked, amountIn: s.amountIn, quoting: s.phase === "quoting", noQuote: s.quote === undefined && s.amountIn > 0n })} className="anim-fade inline-block">
              {buttonLabel(s.phase, {
                side,
                symbol,
                paySymbol: inSym,
                wrongNetwork,
                insufficient,
                slipBlocked,
                amountIn: s.amountIn,
                quoting: s.phase === "quoting",
                noQuote: s.quote === undefined && s.amountIn > 0n,
              })}
            </span>
          </button>
        )}
        {/* Decoded revert reason, inline in the panel — never a toast that vanishes. */}
        {s.error && <p className="mt-2 text-center text-xs text-negative">{s.error}</p>}
      </div>
    </div>
  );
}

function buttonLabel(
  phase: SwapPhase,
  ctx: {
    side: Side;
    symbol: string;
    paySymbol: string;
    wrongNetwork: boolean;
    insufficient: boolean;
    slipBlocked: boolean;
    amountIn: bigint;
    quoting: boolean;
    noQuote: boolean;
  },
): string {
  if (ctx.wrongNetwork) return "Switch to Robinhood Chain";
  // Approving is skipped entirely for a WETH-quoted buy (paySymbol === "ETH");
  // every other leg pulls paySymbol via Permit2.
  if (phase === "approving") return ctx.paySymbol === "ETH" ? "Approving…" : `Approving ${ctx.paySymbol}…`;
  if (phase === "swapping") return "Confirming…";
  if (ctx.amountIn === 0n) return "Enter an amount";
  if (ctx.insufficient) return `Insufficient ${ctx.paySymbol}`;
  if (ctx.slipBlocked) return "Slippage too high";
  if (ctx.quoting) return "Fetching quote…";
  if (ctx.noQuote) return "No quote for this size";
  return ctx.side === "buy" ? `Buy ${ctx.symbol}` : `Sell ${ctx.symbol}`;
}

function AssetChip({ sym }: { sym: string }) {
  return (
    <span className="rounded-full border border-border bg-card px-2.5 py-1 text-sm font-semibold text-text-primary">
      {sym}
    </span>
  );
}

function DetailRow({
  label,
  hint,
  value,
  tone,
}: {
  label: string;
  hint: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-text-faint" title={hint}>
        {label}
      </span>
      <span className={cn("tabular-nums", tone === "warning" ? "text-warning" : "text-text-secondary")}>{value}</span>
    </div>
  );
}

// Any leg that isn't a WETH-quoted buy pulls its input via Permit2, so it carries
// an explicit two-step flow. Each step is marked done as it completes.
function ApprovalSteps({
  phase,
  paySymbol,
  receiveSymbol,
  unwrapsToEth,
}: {
  phase: SwapPhase;
  paySymbol: string;
  receiveSymbol: string;
  unwrapsToEth: boolean;
}) {
  const approveState = phase === "approving" ? "active" : phase === "swapping" || phase === "success" ? "done" : "todo";
  const swapState = phase === "swapping" ? "active" : phase === "success" ? "done" : "todo";
  const idle = phase === "idle" || phase === "quoting";
  return (
    <div className="mt-3 rounded-input border border-border bg-bg px-3 py-2">
      {idle ? (
        <p className="text-xs text-text-faint">
          {unwrapsToEth
            ? "Sell = a one-time Permit2 approval, then the swap. WETH output is unwrapped to ETH for you."
            : `A one-time Permit2 approval, then the swap — you receive ${receiveSymbol} directly.`}
        </p>
      ) : (
        <ol className="space-y-1.5">
          <StepLine state={approveState} label={`Approve ${paySymbol} access (Permit2)`} />
          <StepLine state={swapState} label={`Swap & receive ${receiveSymbol}`} />
        </ol>
      )}
    </div>
  );
}

function StepLine({ state, label }: { state: "todo" | "active" | "done"; label: string }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      {state === "done" ? (
        <span className="text-green" aria-hidden>✓</span>
      ) : state === "active" ? (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-green" aria-hidden />
      ) : (
        <span className="h-3 w-3 rounded-full border-2 border-border" aria-hidden />
      )}
      <span className={state === "todo" ? "text-text-faint" : "text-text-secondary"}>{label}</span>
    </li>
  );
}
