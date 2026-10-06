"use client";

import { formatUnits } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useNow } from "@/hooks/useNow";
import { ConnectButton } from "@/components/app/ConnectButton";
import { activeChain } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";
import { erc20Abi } from "@/lib/abis";
import { PROTOCOL_TOKEN_ADDRESS } from "@/components/app/token/ProtocolTokenNotice";
import { liveQuery } from "@/lib/refresh";
import { useBuybackV2, type TriggerPhase } from "@/hooks/useBuybackV2";
import { BUYBACK_V2_ADDRESS } from "@/lib/contracts";

// The burn address is a compile-time constant of BuybackBurner. Shown here so anyone
// can look up its balance and confirm the burn total independently of this interface.
const DEAD = "0x000000000000000000000000000000000000dEaD";

const EXPLORER = activeChain.blockExplorers.default.url;

// Format a WETH/token amount (1e18) with a sensible number of digits.
function amt(v?: bigint, dp = 4): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, 18));
  return n.toLocaleString("en", { maximumFractionDigits: dp });
}

export default function BuybackPage() {
  // $BALLAST v2's own burned total — read directly from the dead-address
  // balance of the current pinned token.
  const v2Burned = useReadContract({
    address: PROTOCOL_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [DEAD],
    query: liveQuery(Boolean(PROTOCOL_TOKEN_ADDRESS)),
  });
  const v2Supply = useReadContract({
    address: PROTOCOL_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "totalSupply",
    query: liveQuery(Boolean(PROTOCOL_TOKEN_ADDRESS)),
  });
  const v2BurnedVal = v2Burned.data as bigint | undefined;
  const v2SupplyVal = v2Supply.data as bigint | undefined;
  const v2BurnedPct =
    v2BurnedVal !== undefined && v2SupplyVal !== undefined && v2SupplyVal > 0n
      ? Number((v2BurnedVal * 10_000n) / v2SupplyVal) / 100
      : undefined;

  return (
    <div className="relative space-y-5">
      <header>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Buyback &amp; burn</h1>
        {/* Mandated framing, verbatim (spec 2.4) — the first thing a reader sees. */}
        <p className="mt-2 max-w-2xl text-sm text-text-secondary">
          This buys $BALLAST on the open market like any other buyer, and destroys what it buys. It confers nothing on
          holders and predicts nothing about price.
        </p>
      </header>

      {/* ── $BALLAST v2 — permissionless, ownerless burner ───────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure
          label="$BALLAST v2 burned"
          value={amt(v2BurnedVal, 2)}
          sub={v2BurnedPct !== undefined ? `${v2BurnedPct.toFixed(4)}% of supply` : "share of supply —"}
          accent
        />
      </div>
      <p className="max-w-2xl text-xs text-text-faint">
        The platform&apos;s fee share accrues to this contract automatically and anyone may trigger a buyback once
        it&apos;s ready — no owner, no keeper. The Safe may also top it up manually from its own v2 creator-fee
        share.
      </p>
      <BuybackV2Panel />
    </div>
  );
}

// v2's buyback panel. Once BuybackBurnerV2 is deployed and
// NEXT_PUBLIC_BUYBACK_V2_ADDRESS is set, this reads it live: pending
// balances (WETH/NVDA sent by the Safe, not yet spent), per-asset cooldown
// status, and the cumulative burn total. Before that, an honest "manual,
// nothing automated yet" state — never a fabricated log entry.
function readyLabel(readyAt: bigint | undefined, now: number): string {
  if (readyAt === undefined || now === 0) return "Unknown";
  const r = Number(readyAt);
  if (r === 0 || r <= now) return "Ready now";
  const mins = Math.ceil((r - now) / 60);
  return mins < 60 ? `Ready in ${mins}m` : `Ready in ${Math.ceil(mins / 60)}h`;
}

function BuybackV2Panel() {
  const now = useNow();
  const v2 = useBuybackV2();
  const { isConnected } = useAccount();
  const net = useNetworkGuard();

  if (!v2.configured) {
    return (
      <section className="card p-5">
        <h2 className="section-label">v2 buyback</h2>
        <p className="mt-3 text-sm text-text-muted">
          Manual — BuybackBurnerV2 isn&apos;t deployed yet. Once it is, this section reads it live: available
          WETH/NVDA, cooldown status, the last burn, and the trigger itself.
        </p>
      </section>
    );
  }

  return (
    <section className="card p-5">
      <h2 className="section-label">v2 buyback</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="eyebrow">$BALLAST burned</div>
          <div className="mt-1 tabular-nums text-text-primary">{amt(v2.totalBallastBurned, 0)}</div>
        </div>
        <div>
          <div className="eyebrow">Last burn</div>
          {v2.lastBurn ? (
            <a
              className="mt-1 inline-flex items-center gap-1 text-sm text-green underline underline-offset-2"
              href={`${EXPLORER}/tx/${v2.lastBurn.txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              {amt(v2.lastBurn.ballastBought, 0)} removed ↗
            </a>
          ) : v2.historyError ? (
            <div className="mt-1 text-sm text-text-muted">Unknown</div>
          ) : (
            <div className="mt-1 text-sm text-text-muted">None yet</div>
          )}
        </div>
        <div>
          <div className="eyebrow">Buybacks run</div>
          <div className="mt-1 tabular-nums text-text-primary">{v2.buybackCount ?? 0}</div>
        </div>
        {BUYBACK_V2_ADDRESS && (
          <div>
            <div className="eyebrow">Contract</div>
            <a
              className="mt-1 inline-block text-sm text-green underline underline-offset-2"
              href={`${EXPLORER}/address/${BUYBACK_V2_ADDRESS}`}
              target="_blank"
              rel="noreferrer"
            >
              Blockscout ↗
            </a>
          </div>
        )}
      </div>

      <BuybackV2AssetRow
        label="WETH"
        now={now}
        isConnected={isConnected}
        net={net}
        spent={v2.wethSpent}
        waiting={v2.wethAccrued}
        readyAt={v2.wethReadyAt}
        ready={v2.wethReady}
        phase={v2.triggerWethPhase}
        txHash={v2.triggerWethTxHash}
        error={v2.triggerWethError}
        onTrigger={v2.triggerWeth}
        onReset={v2.resetTriggerWeth}
      />
      <BuybackV2AssetRow
        label="NVDA"
        now={now}
        isConnected={isConnected}
        net={net}
        spent={v2.nvdaSpent}
        waiting={v2.nvdaAccrued}
        readyAt={v2.nvdaReadyAt}
        ready={v2.nvdaReady}
        phase={v2.triggerNvdaPhase}
        txHash={v2.triggerNvdaTxHash}
        error={v2.triggerNvdaError}
        onTrigger={v2.triggerNvda}
        onReset={v2.resetTriggerNvda}
        decimals={4}
      />

      {(v2.otherPending.length > 0 || v2.otherForwarded.length > 0) && (
        <div className="mt-5 border-t border-border-subtle pt-4">
          <div className="eyebrow">Platform fees in other assets</div>
          <p className="mt-1 text-xs text-text-faint">
            No pool here to buy back and burn these — forwarded whole to the Safe instead, never held or spent.
          </p>
          <div className="mt-2 space-y-2">
            {v2.otherPending.map((row) => (
              <div key={row.address} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-text-secondary">
                  {amt(row.amount, 4)} {row.symbol ?? shortAddress(row.address)} pending
                </span>
                <button
                  className="btn-secondary text-xs"
                  disabled={v2.forwardOtherPhase === "triggering" || !isConnected}
                  onClick={() => void v2.forwardOther(row.address)}
                >
                  {v2.forwardOtherPhase === "triggering" ? "Confirming…" : "Forward to Safe"}
                </button>
              </div>
            ))}
            {v2.otherForwarded.map((row) => (
              <div key={row.address} className="text-sm text-text-faint">
                {amt(row.amount, 4)} {row.symbol ?? shortAddress(row.address)} forwarded to the Safe
              </div>
            ))}
          </div>
          {v2.forwardOtherError && <p className="mt-2 text-xs text-negative">{v2.forwardOtherError}</p>}
          {v2.forwardOtherPhase === "success" && (
            <div className="mt-2 flex items-center gap-3">
              <p className="text-xs text-green">Forwarded.</p>
              {v2.forwardOtherTxHash && (
                <a
                  className="text-xs text-green underline underline-offset-2"
                  href={`${EXPLORER}/tx/${v2.forwardOtherTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View it on Blockscout ↗
                </a>
              )}
              <button className="text-xs text-text-faint hover:text-text-secondary" onClick={v2.resetForwardOther}>
                Done
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function BuybackV2AssetRow({
  label,
  now,
  isConnected,
  net,
  spent,
  waiting,
  readyAt,
  ready,
  phase,
  txHash,
  error,
  onTrigger,
  onReset,
  decimals,
}: {
  label: string;
  now: number;
  isConnected: boolean;
  net: ReturnType<typeof useNetworkGuard>;
  spent?: bigint;
  waiting?: bigint;
  readyAt?: bigint;
  ready: boolean;
  phase: TriggerPhase;
  txHash?: `0x${string}`;
  error?: string;
  onTrigger: () => Promise<void>;
  onReset: () => void;
  decimals?: number;
}) {
  const busy = phase === "triggering";
  return (
    <div className="mt-4 border-t border-border-subtle pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <div>
            <div className="eyebrow">{label} spent</div>
            <div className="mt-1 tabular-nums text-text-primary">{amt(spent, decimals)}</div>
          </div>
          <div>
            <div className="eyebrow">{label} waiting here</div>
            <div
              className="mt-1 tabular-nums text-text-primary"
              title="Held balance plus whatever is still claimable from the configured fee hooks."
            >
              {amt(waiting, decimals)}
            </div>
          </div>
          <div>
            <div className="eyebrow">Next {label} buyback</div>
            <div className="mt-1 text-text-secondary">{readyLabel(readyAt, now)}</div>
          </div>
        </div>

        {phase === "success" ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-green">Confirmed — burned.</span>
            {txHash && (
              <a
                className="text-xs text-green underline underline-offset-2"
                href={`${EXPLORER}/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View ↗
              </a>
            )}
            <button className="text-xs text-text-faint hover:text-text-secondary" onClick={onReset}>
              Done
            </button>
          </div>
        ) : !isConnected ? (
          <ConnectButton />
        ) : net.wrongNetwork ? (
          <button className="btn-secondary text-xs" disabled={net.isSwitching} onClick={() => void net.switchToRobinhood()}>
            {net.isSwitching ? "Switching…" : `Switch to ${net.targetChain.name}`}
          </button>
        ) : (
          <button
            className="btn-secondary text-xs"
            disabled={busy || !ready}
            onClick={() => void onTrigger()}
            title={ready ? undefined : "Nothing available to spend, or the per-asset cooldown hasn't elapsed."}
          >
            {busy ? "Confirming…" : ready ? "Run buyback" : "Not ready"}
          </button>
        )}
      </div>
      {(error || net.error) && <p className="mt-2 text-xs text-negative">{error ?? net.error}</p>}
    </div>
  );
}

function Figure({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={cn("card p-4", accent && "border-accent")}>
      <div className="eyebrow">{label}</div>
      <div className="mt-1 figure-primary text-2xl tabular-nums">{value}</div>
      {sub && <div className="metric-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

