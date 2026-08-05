"use client";

import { useState } from "react";
import Link from "next/link";
import { formatUnits } from "viem";
import { useBuyback, type BurnRow } from "@/hooks/useBuyback";
import { useNow } from "@/hooks/useNow";
import { Meander } from "@/components/Meander";
import { activeChain } from "@/lib/chain";
import { formatEt } from "@/lib/marketHours";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

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

      {!s.configured ? (
        <Notice
          title="Not live yet"
          body="The buyback contract isn't deployed on this network yet. Once it is (and NEXT_PUBLIC_BUYBACK_ADDRESS is set), every figure and every burn on this page is read live from chain — nothing here is stored or hand-entered."
        />
      ) : (
        <>
          {/* ── Header figures ─────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Figure
              label="$BALLAST burned"
              value={amt(s.totalBurned, 2)}
              sub={
                s.burnedPctBps !== undefined
                  ? `${(s.burnedPctBps / 100).toFixed(2)}% of supply`
                  : "share of supply —"
              }
              accent
            />
            <Figure label="WETH spent on buybacks" value={amt(s.totalWethSpent)} sub={`${s.buybackCount ?? 0} buybacks`} />
            <Figure label="Fees accrued, not yet spent" value={amt(s.accruedWeth)} sub="WETH waiting" />
            <NextBuyback threshold={s.threshold} accrued={s.accruedWeth} />
          </div>

          {/* ── How a buyback runs (mechanics observed on-chain) ───────── */}
          <p className="max-w-2xl text-xs text-text-faint">
            Each buyback is size-capped so a single call can&apos;t swing the pool. The pool is thin, so a large
            accrued balance isn&apos;t spent all at once — it&apos;s spent across many small buybacks, automatically:
            whatever a call can&apos;t buy within its price cap simply stays and funds the next one. Nothing is lost
            between them.
          </p>

          {/* ── Copy rules block (spec 2.4) ────────────────────────────── */}
          <p className="max-w-2xl text-xs text-text-faint">
            Burning reduces the circulating supply. What happens to price after that is not something we control or
            predict — this page states what was bought and destroyed, nothing more.
          </p>

          {/* ── Burn address ───────────────────────────────────────────── */}
          <section className="card p-5">
            <h2 className="section-label">The burn address</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Every token bought is sent here and can never be moved again. Confirm the total yourself — you don&apos;t
              have to trust this page.
            </p>
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
            <h2 className="section-label">Where the money comes from</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              <Node>1% swap fee (WETH)</Node>
              <Arrow />
              <Node>creator + platform + referrer shares</Node>
              <Arrow />
              <Node>platform share</Node>
              <Arrow />
              <Node accent>funds this buyback</Node>
            </div>
            <p className="mt-3 text-xs text-text-faint">
              Only the platform&apos;s share of the swap fee funds buybacks — no treasury assets, and no fee on treasury
              deposits. Each buyback is itself a swap through the pool, so it pays the same 1% fee and appears in the
              trades feed like any other buy. Because of that fee, a small slice of every buyback flows back into the
              fee pool rather than into burned tokens — so the $BALLAST burned is always a little less than the WETH
              accrued, not a one-to-one conversion.{" "}
              <Link href="/docs/how-ballast-works" className="text-green underline underline-offset-2">
                How the fee works ↗
              </Link>
            </p>
          </section>

          {/* ── Who controls this ──────────────────────────────────────── */}
          <WhoControls />

          <Meander className="opacity-60" />
        </>
      )}
    </div>
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
      <p className="mt-3 text-xs text-text-faint">
        $BALLAST has no burn function, so its <span className="font-mono">totalSupply</span> is unchanged; the burned
        tokens sit permanently at the dead address. Circulating is total supply minus that balance.
      </p>
    </section>
  );
}

function WhoControls() {
  return (
    <section className="card p-5">
      <h2 className="section-label">Who controls this</h2>
      <p className="mt-2 text-sm text-text-secondary">
        This contract is owned by a single BALLAST-team key — not a multisig, today. We&apos;d rather say that plainly
        than wait on a wallet we can&apos;t yet create. Here is exactly what that key can and cannot do; verify the owner
        yourself with <span className="font-mono">owner()</span> on the contract.
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
            Change the threshold that triggers a buyback (delaying one, never diverting it), adjust the price-impact cap
            within a fixed 20% ceiling, and change which fee ledgers it sweeps.
          </dd>
        </div>
        <div>
          <dt className="eyebrow">It cannot</dt>
          <dd className="mt-1 text-sm text-text-secondary">
            Withdraw the WETH, change the token it buys, or change the burn address — there is no function for any of
            these. Every token a buyback buys goes to <span className="font-mono">0x…dEaD</span>, fixed in the contract.
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-text-faint">
        One thing to know: the platform fee only reaches this contract because the fee config points here. The same key
        controls that config and could point <em>future</em> fees elsewhere — it cannot touch WETH already held here,
        which can only ever be spent buying $BALLAST and burning it. When ownership moves to a multisig, this section
        will say so.{" "}
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
        <p className="mt-3 text-sm text-warning">Couldn&apos;t read the burn events right now — the RPC may be busy. Retry shortly.</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          {loading ? "Reading burn events…" : "No buybacks yet. The first one appears here — and on Blockscout — the moment it executes."}
        </p>
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
      <p className="mt-4 text-[11px] text-text-faint">
        Read live from the contract&apos;s BuybackBurned events. Every row links to Blockscout — verify each without
        trusting this page.
      </p>
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
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-sm text-text-secondary transition-colors hover:border-text-faint"
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
