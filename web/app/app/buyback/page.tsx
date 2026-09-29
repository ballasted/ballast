"use client";

import { useState } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { useBuyback, type BurnRow, type BuybackState } from "@/hooks/useBuyback";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useNow } from "@/hooks/useNow";
import { ConnectButton } from "@/components/app/ConnectButton";
import { Meander } from "@/components/Meander";
import { activeChain } from "@/lib/chain";
import { formatEt } from "@/lib/marketHours";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";
import { erc20Abi } from "@/lib/abis";
import { PROTOCOL_TOKEN_ADDRESS } from "@/components/app/token/ProtocolTokenNotice";
import { liveQuery } from "@/lib/refresh";
import { useBuybackV2 } from "@/hooks/useBuybackV2";
import { BUYBACK_V2_ADDRESS } from "@/lib/contracts";

// The burn address is a compile-time constant of BuybackBurner. Shown here so anyone
// can look up its balance and confirm the burn total independently of this interface.
const DEAD = "0x000000000000000000000000000000000000dEaD";

// The address that owns the buyback today. It is a single team key, NOT a multisig
// yet — disclosed here rather than discovered. When ownership moves to the project
// multisig, update this and the copy below (and note it in /docs/corrections).
const OWNER = "0xA2774e53dCb666799dbA7d00dC11d10d7Ff837D1";

const EXPLORER = activeChain.blockExplorers.default.url;

// Format a WETH/token amount (1e18) with a sensible number of digits.
function amt(v?: bigint, dp = 4): string {
  if (v === undefined) return "—";
  const n = Number(formatUnits(v, 18));
  return n.toLocaleString("en", { maximumFractionDigits: dp });
}

export default function BuybackPage() {
  const s = useBuyback();
  const now = useNow();

  // $BALLAST v2's own burned total — read directly from the dead-address
  // balance of the CURRENT pinned token, independent of the v1-only
  // BuybackBurner contract below. This is the headline figure; there is no
  // automated v2 burner yet (FeeSplitter v2 hasn't shipped — see "Where the
  // money comes from" below), so today it reads 0 until the Safe runs a
  // manual buyback. Never summed with v1's total: two different tokens,
  // two different mechanisms, shown separately on purpose.
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

      {/* ── $BALLAST v2 — the current, manual mechanism ─────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Figure
          label="$BALLAST v2 burned"
          value={amt(v2BurnedVal, 2)}
          sub={v2BurnedPct !== undefined ? `${v2BurnedPct.toFixed(4)}% of supply` : "share of supply —"}
          accent
        />
      </div>
      <p className="max-w-2xl text-xs text-text-faint">
        Manual today — the 20% platform fee share on v2 launches isn&apos;t routed through an automated buyback
        contract yet (FeeSplitter v2 hasn&apos;t shipped). The Safe buys and burns by hand; every buyback it runs is
        logged here once it happens. Nothing to log yet.
      </p>
      <BuybackV2Panel />

      {/* ── v1 history (legacy mechanism) — never summed with v2 above ──── */}
      <section className="mt-2">
        <h2 className="font-serif text-lg font-semibold text-bone">v1 history</h2>
        <p className="mt-1 max-w-2xl text-xs text-text-faint">
          $BALLAST v1&apos;s automated buyback ran independently, on its own contract, against its own pool. Kept
          here for the record — its burn total is v1-only and is never added to v2&apos;s figure above.
        </p>
      </section>

      {!s.configured ? (
        <Notice
          title="v1 buyback contract not configured"
          body="NEXT_PUBLIC_BUYBACK_ADDRESS isn't set, so v1's legacy figures below can't be read."
        />
      ) : (
        <>
          {/* ── Header figures ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Figure
              label="$BALLAST v1 burned"
              value={amt(s.totalBurned, 2)}
              sub={
                s.burnedPctBps !== undefined
                  ? `${(s.burnedPctBps / 100).toFixed(2)}% of v1 supply`
                  : "share of supply —"
              }
            />
            <Figure label="WETH spent on buybacks" value={amt(s.totalWethSpent)} sub={`${s.buybackCount ?? 0} buybacks`} />
            <Figure label="Fees accrued, not yet spent" value={amt(s.accruedWeth)} sub="WETH waiting" />
            <NextBuyback threshold={s.threshold} accrued={s.accruedWeth} />
          </div>

          {/* ── Trigger (the one write on this page) ────────────────────── */}
          <TriggerBuyback s={s} />

          {/* ── Copy rules block (spec 2.4) ────────────────────────────── */}
          <p className="max-w-2xl text-xs text-text-faint">
            Burning reduces the circulating supply. What happens to price after that is not something we control or
            predict — this page states what was bought and destroyed, nothing more.
          </p>

          {/* ── Burn address ───────────────────────────────────────────── */}
          <section className="card p-5">
            <h2 className="section-label">The burn address</h2>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <CopyAddress address={DEAD} />
              {s.ballast && (
                <a
                  className="text-xs text-green underline underline-offset-2"
                  href={`${EXPLORER}/token/${s.ballast}?a=${DEAD}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View its $BALLAST balance on Blockscout ↗
                </a>
              )}
            </div>
          </section>

          {/* ── Supply effect ──────────────────────────────────────────── */}
          <SupplyEffect totalSupply={s.totalSupply} burned={s.totalBurned} />

          {/* ── Burn history ───────────────────────────────────────────── */}
          <BurnHistory rows={s.history} error={s.historyError} loading={s.isLoading} now={now} />

          {/* ── Where the money comes from ─────────────────────────────── */}
          <section className="card p-5">
            <h2 className="section-label">Where the money comes from (v1)</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              <Node>1% swap fee (WETH)</Node>
              <Arrow />
              <Node>creator + platform + referrer shares</Node>
              <Arrow />
              <Node>platform share</Node>
              <Arrow />
              <Node accent>funds this buyback</Node>
            </div>
            <Link href="/docs/how-ballast-works" className="mt-3 inline-block text-xs text-green underline underline-offset-2">
              How the fee works ↗
            </Link>
          </section>

          {/* ── Who controls this ──────────────────────────────────────── */}
          <WhoControls />

          <Meander className="opacity-60" />
        </>
      )}
    </div>
  );
}

// v2's buyback panel. Once BuybackBurnerV2 is deployed and
// NEXT_PUBLIC_BUYBACK_V2_ADDRESS is set, this reads it live: pending
// balances (WETH/NVDA sent by the Safe, not yet spent), per-asset cooldown
// status, and the cumulative burn total. Before that, an honest "manual,
// nothing automated yet" state — never a fabricated log entry.
function BuybackV2Panel() {
  const now = useNow();
  const v2 = useBuybackV2();

  if (!v2.configured) {
    return (
      <section className="card p-5">
        <h2 className="section-label">v2 buyback</h2>
        <p className="mt-3 text-sm text-text-muted">
          Manual — BuybackBurnerV2 isn&apos;t deployed yet. Once it is, this section reads it live: pending balances,
          cooldown status, and every burn.
        </p>
      </section>
    );
  }

  function readyLabel(readyAt?: bigint): string {
    if (readyAt === undefined || now === 0) return "—";
    const r = Number(readyAt);
    if (r === 0 || r <= now) return "Ready now";
    const mins = Math.ceil((r - now) / 60);
    return mins < 60 ? `Ready in ${mins}m` : `Ready in ${Math.ceil(mins / 60)}h`;
  }

  return (
    <section className="card p-5">
      <h2 className="section-label">v2 buyback</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="eyebrow">WETH pending</div>
          <div className="mt-1 tabular-nums text-text-primary">{amt(v2.wethPendingBalance)}</div>
        </div>
        <div>
          <div className="eyebrow">NVDA pending</div>
          <div className="mt-1 tabular-nums text-text-primary">{amt(v2.nvdaPendingBalance, 4)}</div>
        </div>
        <div>
          <div className="eyebrow">WETH buyback</div>
          <div className="mt-1 text-text-secondary">{readyLabel(v2.wethReadyAt)}</div>
        </div>
        <div>
          <div className="eyebrow">NVDA buyback</div>
          <div className="mt-1 text-text-secondary">{readyLabel(v2.nvdaReadyAt)}</div>
        </div>
      </div>
      <p className="mt-3 text-xs text-text-faint">
        {v2.buybackCount ?? 0} buyback{v2.buybackCount === 1 ? "" : "s"} run · permissionless once ready — anyone may
        call it, no owner exists.
      </p>
      {BUYBACK_V2_ADDRESS && (
        <a
          className="mt-2 inline-block text-xs text-green underline underline-offset-2"
          href={`${EXPLORER}/address/${BUYBACK_V2_ADDRESS}`}
          target="_blank"
          rel="noreferrer"
        >
          View the contract on Blockscout ↗
        </a>
      )}
    </section>
  );
}

function NextBuyback({ threshold, accrued }: { threshold?: bigint; accrued?: bigint }) {
  const ready = threshold !== undefined && accrued !== undefined && accrued >= threshold;
  const pct =
    threshold !== undefined && threshold > 0n && accrued !== undefined
      ? Math.min(100, Number((accrued * 100n) / threshold))
      : undefined;
  return (
    <div className="card p-4">
      <div className="eyebrow">Next buyback</div>
      {threshold === undefined ? (
        <div className="mt-1 text-sm text-text-muted">—</div>
      ) : ready ? (
        <div className="mt-1 text-sm font-medium text-green">Ready — anyone can trigger it now</div>
      ) : (
        <div className="mt-1 text-sm text-text-secondary">
          At {amt(threshold)} WETH accrued{pct !== undefined ? ` · ${pct}% there` : ""}
        </div>
      )}
      <p className="mt-1 text-xs text-text-faint">Not scheduled — permissionless once the threshold is met.</p>
    </div>
  );
}

// The single write on this page. A buyback never runs on its own — the contract just
// sits until someone sends a transaction. This is that transaction: permissionless,
// so any connected wallet may run it once accrued ≥ threshold. The caller pays gas and
// receives nothing — every token bought goes to the dead address. We say that plainly
// so no one mistakes triggering it for a way to earn anything.
function TriggerBuyback({ s }: { s: BuybackState }) {
  const { isConnected } = useAccount();
  const net = useNetworkGuard();
  const busy = s.triggerPhase === "triggering";

  return (
    <section className="card p-5">
      <h2 className="section-label">Trigger this buyback</h2>
      <p className="mt-2 max-w-2xl text-sm text-text-secondary">
        Nothing runs on a schedule — a buyback happens only when someone sends this public transaction. You pay gas and
        receive nothing: it claims the accrued WETH, buys $BALLAST, and burns every token.
      </p>

      {s.triggerPhase === "success" ? (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-green">Buyback confirmed — the $BALLAST it bought was burned.</p>
          <div className="flex flex-wrap items-center gap-3">
            {s.triggerTxHash && (
              <a
                className="text-xs text-green underline underline-offset-2"
                href={`${EXPLORER}/tx/${s.triggerTxHash}`}
                target="_blank"
                rel="noreferrer"
              >
                View it on Blockscout ↗
              </a>
            )}
            <button className="text-xs text-text-faint hover:text-text-secondary" onClick={s.resetTrigger}>
              Done
            </button>
          </div>
        </div>
      ) : !isConnected ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <ConnectButton />
          <span className="text-xs text-text-faint">Connect a wallet to trigger a buyback.</span>
        </div>
      ) : net.wrongNetwork ? (
        <button
          className="btn-primary mt-4 w-full sm:w-auto"
          disabled={net.isSwitching}
          onClick={() => void net.switchToRobinhood()}
        >
          {net.isSwitching ? "Switching…" : `Switch to ${net.targetChain.name}`}
        </button>
      ) : (
        <button
          className="btn-primary mt-4 w-full sm:w-auto"
          disabled={busy || !s.ready}
          onClick={() => void s.trigger()}
          title={s.ready ? undefined : "The accrued WETH hasn't reached the threshold yet."}
        >
          {busy ? "Confirming…" : s.ready ? "Trigger buyback & burn" : "Below threshold — not ready yet"}
        </button>
      )}

      {(s.triggerError || net.error) && (
        <p className="mt-2 text-xs text-negative">{s.triggerError ?? net.error}</p>
      )}
    </section>
  );
}

function SupplyEffect({ totalSupply, burned }: { totalSupply?: bigint; burned?: bigint }) {
  const pctBurned =
    totalSupply !== undefined && totalSupply > 0n && burned !== undefined
      ? Math.min(100, Number((burned * 10_000n) / totalSupply) / 100)
      : 0;
  const circulating = totalSupply !== undefined && burned !== undefined ? totalSupply - burned : undefined;
  return (
    <section className="card p-5">
      <h2 className="section-label">Supply effect</h2>
      <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-surface-raised" aria-hidden>
        <div className="h-full rounded-full bg-green" style={{ width: `${pctBurned}%` }} />
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-text-faint">Original supply</dt>
          <dd className="tabular-nums text-text-primary">{amt(totalSupply, 0)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-faint">Circulating</dt>
          <dd className="tabular-nums text-text-primary">{amt(circulating, 0)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-faint">Burned</dt>
          <dd className="tabular-nums text-green">{amt(burned, 0)}</dd>
        </div>
      </dl>
    </section>
  );
}

function WhoControls() {
  return (
    <section className="card p-5">
      <h2 className="section-label">Who controls this</h2>
      <p className="mt-2 text-sm text-text-secondary">
        Owned by a single BALLAST-team key, not a multisig yet — we&apos;d rather say so plainly. Here&apos;s what it
        can and can&apos;t do; verify with <span className="font-mono">owner()</span>.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <CopyAddress address={OWNER} />
        <a
          className="text-xs text-green underline underline-offset-2"
          href={`${EXPLORER}/address/${OWNER}`}
          target="_blank"
          rel="noreferrer"
        >
          View the owner on Blockscout ↗
        </a>
      </div>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="eyebrow">It can</dt>
          <dd className="mt-1 text-sm text-text-secondary">
            Change the trigger threshold (delay, never divert), adjust the price-impact cap under a fixed 20% ceiling,
            and change which fee ledgers it sweeps.
          </dd>
        </div>
        <div>
          <dt className="eyebrow">It cannot</dt>
          <dd className="mt-1 text-sm text-text-secondary">
            Withdraw WETH, change the token it buys, or change the burn address — no function exists. Bought tokens
            always go to <span className="font-mono">0x…dEaD</span>, fixed in the contract.
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-text-faint">
        The same key controls the fee config and could redirect future fees elsewhere — but it can never touch WETH
        already here, which can only buy and burn $BALLAST. We&apos;ll note it here when ownership moves to a multisig.{" "}
        <Link href="/docs/corrections" className="text-green underline underline-offset-2">
          On the record ↗
        </Link>
      </p>
    </section>
  );
}

function BurnHistory({ rows, error, loading, now }: { rows: BurnRow[]; error: boolean; loading: boolean; now: number }) {
  return (
    <section className="card p-5">
      <h2 className="section-label">Burn history</h2>
      {error ? (
        <span className="chip chip-warning mt-3 inline-flex">RPC unavailable</span>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">{loading ? "Loading…" : "Nothing yet."}</p>
      ) : (
        <>
          {/* Table on desktop, cards on mobile. */}
          <div className="mt-3 hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left eyebrow">
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 text-right font-medium">WETH spent</th>
                  <th className="pb-2 text-right font-medium">$BALLAST bought</th>
                  <th className="pb-2 text-right font-medium">Effective price</th>
                  <th className="pb-2 text-right font-medium">Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.txHash}>
                    <td className="py-2 text-text-secondary">{r.timestamp ? formatEt(r.timestamp) : "—"}</td>
                    <td className="py-2 text-right tabular-nums text-text-primary">{amt(r.wethSpent)}</td>
                    <td className="py-2 text-right tabular-nums text-text-primary">{amt(r.ballastBought, 2)}</td>
                    <td className="py-2 text-right tabular-nums text-text-muted">
                      {r.effectivePriceWeth ? `${amt(r.effectivePriceWeth, 8)} WETH` : "—"}
                    </td>
                    <td className="py-2 text-right">
                      <a className="text-green underline underline-offset-2" href={`${EXPLORER}/tx/${r.txHash}`} target="_blank" rel="noreferrer">
                        {shortAddress(r.txHash)} ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-3 space-y-2 sm:hidden">
            {rows.map((r) => (
              <li key={r.txHash} className="rounded-input border border-border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary">{r.timestamp ? formatEt(r.timestamp) : "—"}</span>
                  <a className="text-xs text-green underline underline-offset-2" href={`${EXPLORER}/tx/${r.txHash}`} target="_blank" rel="noreferrer">
                    {shortAddress(r.txHash)} ↗
                  </a>
                </div>
                <div className="mt-1 flex justify-between tabular-nums">
                  <span className="text-text-muted">{amt(r.wethSpent)} WETH</span>
                  <span className="text-text-primary">{amt(r.ballastBought, 2)} $BALLAST</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
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

function Node({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full border px-3 py-1 text-xs",
        accent ? "border-green bg-green-bg text-green" : "border-border text-text-secondary",
      )}
    >
      {children}
    </span>
  );
}

function Arrow() {
  return <span className="text-text-faint" aria-hidden>→</span>;
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-sm text-text-secondary transition-colors hover:border-text-faint md:min-h-0"
      title={`Copy ${address}`}
    >
      <span className="font-mono">{copied ? "Copied ✓" : address}</span>
    </button>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif font-semibold text-bone">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}
