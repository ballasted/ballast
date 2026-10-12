"use client";

import { useMemo, useState } from "react";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { useBasket } from "@/hooks/useBasket";
import { useBasketRunner, type BasketLeg } from "@/hooks/useBasketRunner";
import { routeFor, BASKET_PRESETS } from "@/lib/basketRoutes";
import { computeMinOut, swapDeadline } from "@/lib/swap";
import { AssetDisc } from "@/components/app/AssetDisc";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/cn";

/// Picker used both as the optional post-launch Create step and as the
/// creator-only "Add basket" flow on the token page. Deliberately honest about
/// the two-stage signature cost (docs/DECISIONS.md §1): one signature swaps
/// ETH into every leg at once, but each resulting asset still needs its own
/// approve + deposit against the treasury directly — BasketZap can never make
/// that call for the creator.
export function BasketPicker({
  launchToken,
  treasury,
  onDone,
}: {
  launchToken: Address;
  treasury: Address;
  onDone?: () => void;
}) {
  const { address: account } = useAccount();
  const basket = useBasket();
  const runner = useBasketRunner();

  if (!basket.isConfigured) {
    return <InlineNotice>Deploy the AssetRegistry and set NEXT_PUBLIC_ASSET_REGISTRY_ADDRESS to enable a basket.</InlineNotice>;
  }
  if (basket.isLoading) {
    return <div className="card h-40 animate-pulse p-5" />;
  }
  if (!basket.hasRoutableAssets) {
    return (
      <InlineNotice>
        No AssetRegistry asset has a real on-chain WETH route yet — see docs/BASKET_DISCOVERY.md. Basket deposits need a
        real pool to swap through; none has been sourced and verified as of this build.
      </InlineNotice>
    );
  }

  if (runner.steps.length > 0) {
    return <BasketProgress steps={runner.steps} isRunning={runner.isRunning} done={runner.done} onDone={onDone} />;
  }

  async function onConfirm() {
    if (!basket.weightsValid || basket.ethWei === 0n) return;
    const legs: BasketLeg[] = basket.legs
      .filter((l) => l.weightBps > 0)
      .map((l) => {
        const route = routeFor(l.address)!;
        const minOut = computeMinOut(l.quoteOut, basket.slippageBps);
        return {
          asset: l.address,
          symbol: l.symbol,
          weightBps: l.weightBps,
          fee: route.fee,
          tickSpacing: route.tickSpacing,
          hooks: route.hooks,
          minOut: minOut > 0n ? minOut : 1n,
        };
      });
    await runner.run({
      launchToken,
      treasury,
      ethIn: basket.ethWei,
      legs,
      deadline: swapDeadline(Math.floor(Date.now() / 1000)),
    });
  }

  const totalUsd =
    basket.ethUsd1e18 !== undefined && basket.ethWei > 0n ? (basket.ethWei * basket.ethUsd1e18) / 10n ** 18n : undefined;

  return (
    <div className="space-y-4">
      <div>
        <div className="field-label mb-2">Preset</div>
        <div className="flex flex-wrap gap-2">
          {BASKET_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => basket.applyPreset(p.id)}
              className={cn("tab", basket.preset === p.id ? "tab-active" : "tab-idle")}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="field-label mb-2">Assets (routable only)</div>
        <div className="flex flex-wrap gap-2">
          {basket.routable.map((a) => {
            const picked = basket.legs.some((l) => l.address === a.address);
            return (
              <button
                key={a.address}
                type="button"
                disabled={a === undefined}
                onClick={() => basket.toggleAsset(a.address)}
                className={cn("chip", picked ? "chip-active" : "chip-idle")}
              >
                <AssetDisc identity={{ status: "recognized", symbol: a.symbol ?? "" }} size={18} />
                {a.symbol}
              </button>
            );
          })}
        </div>
      </div>

      {basket.legs.length > 0 && (
        <div className="space-y-3">
          <div className="field-label">Weights</div>
          {basket.legs.map((l) => (
            <LegRow key={l.address} leg={l} onChangePct={(pct) => basket.setWeightPct(l.address, pct)} ethWei={basket.ethWei} />
          ))}
          <div className="flex items-center justify-between text-xs text-text-faint">
            <span>Total</span>
            <span className={basket.weightsValid ? "text-text-secondary" : "text-negative"}>{basket.totalWeightBps / 100}%</span>
          </div>
        </div>
      )}

      {basket.anyMarketClosed && (
        <div className="note note-warning">
          <div className="font-semibold text-warning">Market closed, price feed paused</div>
          <p className="mt-1 text-text-secondary">One or more selected assets can&apos;t be priced right now. Remove it or wait for its market to open.</p>
        </div>
      )}

      <div>
        <div className="field-label mb-1">Total ETH</div>
        <input
          className="input"
          inputMode="decimal"
          placeholder="0.0"
          value={basket.ethAmount}
          onChange={(e) => basket.setEthAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        />
        {totalUsd !== undefined && <p className="mt-1 text-xs text-text-faint">{formatUsd(totalUsd, { compact: true })}</p>}
      </div>

      <div>
        <div className="field-label mb-1">Slippage</div>
        <div className="grid grid-cols-4 gap-2">
          {[50, 100, 200, 500].map((bps) => (
            <button
              key={bps}
              type="button"
              onClick={() => basket.setSlippageBps(bps)}
              className={cn("tab-segment border", basket.slippageBps === bps ? "tab-active" : "tab-idle")}
            >
              {(bps / 100).toFixed(bps === 50 ? 1 : 0)}%
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-text-faint">
        One signature swaps ETH into every asset above; each asset then needs its own approve + deposit confirmation into
        your treasury — {basket.legs.filter((l) => l.weightBps > 0).length * 2 + 1} signatures total.
      </p>

      {!account ? (
        <p className="text-center text-sm text-text-muted">Connect a wallet to add a basket.</p>
      ) : (
        <button
          className="btn-primary w-full"
          disabled={!basket.weightsValid || basket.ethWei === 0n || basket.anyMarketClosed}
          onClick={() => void onConfirm()}
        >
          Swap &amp; review
        </button>
      )}
    </div>
  );
}

function LegRow({
  leg,
  onChangePct,
  ethWei,
}: {
  leg: ReturnType<typeof useBasket>["legs"][number];
  onChangePct: (pct: number) => void;
  ethWei: bigint;
}) {
  const amountIn = ethWei > 0n ? (ethWei * BigInt(leg.weightBps)) / 10_000n : 0n;
  return (
    <div className="flex items-center gap-3">
      <AssetDisc identity={{ status: "recognized", symbol: leg.symbol ?? "" }} size={24} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-primary">{leg.symbol}</span>
          <span className="tabular-nums text-text-muted">{leg.weightBps / 100}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={leg.weightBps / 100}
          onChange={(e) => onChangePct(Number(e.target.value))}
          className="w-full"
        />
        {amountIn > 0n && (
          <div className="text-xs text-text-faint">
            {Number(formatUnits(amountIn, 18)).toLocaleString("en", { maximumFractionDigits: 5 })} ETH
            {leg.quoteOut !== undefined && leg.decimals !== undefined && (
              <> → {Number(formatUnits(leg.quoteOut, leg.decimals)).toLocaleString("en", { maximumFractionDigits: 4 })} {leg.symbol}</>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function BasketProgress({
  steps,
  isRunning,
  done,
  onDone,
}: {
  steps: ReturnType<typeof useBasketRunner>["steps"];
  isRunning: boolean;
  done: boolean;
  onDone?: () => void;
}) {
  return (
    <div className="space-y-3">
      <ol className="space-y-3">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-3">
            <StepDot status={s.status} />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-text-primary">{s.label}</div>
              {s.error && <div className="text-xs text-negative">{s.error}</div>}
            </div>
          </li>
        ))}
      </ol>
      {done && (
        <button className="btn-primary w-full" onClick={onDone}>
          Done
        </button>
      )}
      {!isRunning && !done && steps.some((s) => s.status === "error" || s.status === "lost") && (
        <p className="text-xs text-text-faint">Check your wallet / Blockscout before retrying this step.</p>
      )}
    </div>
  );
}

function StepDot({ status }: { status: string }) {
  const map: Record<string, string> = {
    idle: "border-border",
    pending: "border-warning animate-pulse",
    confirming: "border-warning animate-pulse",
    success: "border-green bg-green",
    error: "border-negative bg-negative",
    lost: "border-warning bg-warning",
  };
  return <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2", map[status] ?? "border-border")} />;
}

function InlineNotice({ children }: { children: React.ReactNode }) {
  return <div className="note p-4 text-sm text-text-secondary">{children}</div>;
}
