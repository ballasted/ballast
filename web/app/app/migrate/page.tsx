"use client";

import { useState } from "react";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { useV1Claim, useMigrationStats } from "@/hooks/useV1Claim";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useNow } from "@/hooks/useNow";
import { ConnectButton } from "@/components/app/ConnectButton";
import { Meander } from "@/components/Meander";
import { activeChain } from "@/lib/chain";
import { cn } from "@/lib/cn";

const EXPLORER = activeChain.blockExplorers.default.url;

function fmtEth(v?: bigint): string {
  if (v === undefined) return "—";
  return Number(formatUnits(v, 18)).toLocaleString("en", { maximumFractionDigits: 6 });
}
function fmtV1(v?: bigint): string {
  if (v === undefined) return "—";
  return Number(formatUnits(v, 18)).toLocaleString("en", { maximumFractionDigits: 2 });
}

export default function MigratePage() {
  const { address, isConnected } = useAccount();
  const net = useNetworkGuard();
  const now = useNow();
  const c = useV1Claim(address);
  const stats = useMigrationStats();
  const [pct, setPct] = useState(100);
  const TOTAL_ETH_BUDGET = 693084308357578318n; // data/snapshot/v1_claim_eth_meta.json

  return (
    <div className="relative space-y-5">
      <header>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">v1 → v2 migration</h1>
        <p className="mt-2 max-w-2xl text-sm text-text-secondary">
          Burn your snapshotted $BALLAST v1 permanently, receive ETH in return. Holding v1 gave no claim on anything —
          this is a one-time, opt-in exchange, not a redemption right you always had.
        </p>
      </header>

      {c.configured && (
        <section className="card p-5">
          <h2 className="section-label">Migration progress</h2>
          {stats.error ? (
            <span className="chip chip-warning mt-3 inline-flex">RPC unavailable</span>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure
                label="ETH paid out"
                value={stats.isLoading ? "…" : fmtEth(stats.totalEthPaid)}
                sub={`of ${fmtEth(TOTAL_ETH_BUDGET)} total`}
              />
              <Figure
                label="Claimed"
                value={
                  stats.isLoading
                    ? "…"
                    : `${((Number(stats.totalEthPaid) / Number(TOTAL_ETH_BUDGET)) * 100).toFixed(1)}%`
                }
                sub="of the total budget"
              />
              <Figure label="v1 burned" value={stats.isLoading ? "…" : fmtV1(stats.totalV1Burned)} sub="permanently" />
              <Figure label="Holders claimed" value={stats.isLoading ? "…" : String(stats.uniqueClaimers)} sub="of 71 in the snapshot" />
            </div>
          )}
        </section>
      )}

      {!c.configured ? (
        <Notice
          title="Not live yet"
          body="The migration contract isn't deployed here yet. Once it is, every figure on this page reads live from chain."
        />
      ) : !isConnected ? (
        <section className="card p-8 text-center">
          <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
          <h2 className="font-serif font-semibold text-bone">Connect to check eligibility</h2>
          <div className="mt-4 flex justify-center">
            <ConnectButton />
          </div>
        </section>
      ) : c.loadError ? (
        <Notice title="Couldn't load the claim list" body="Try reloading the page." />
      ) : !c.isInSnapshot ? (
        <Notice
          title="Not in the snapshot"
          body={`This address didn't hold $BALLAST v1 at the snapshot (block 73,030,228, 2026-09-26 11:00 UTC). ${c.holders ?? ""} addresses were included.`}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Figure label="Snapshot balance" value={fmtV1(c.snapshotBalance)} sub="$BALLAST v1" />
            <Figure label="Current v1 balance" value={fmtV1(c.v1Balance)} sub="what you can still burn" />
            <Figure label="ETH claimed so far" value={fmtEth(c.claimedEth)} sub={`of ${fmtEth(c.ethAmount)} total`} accent />
            <Deadline deadline={c.deadline} now={now} />
          </div>

          {c.fullyClaimed ? (
            <section className="card p-5 text-center">
              <p className="text-sm text-green">Fully claimed — every ETH you were owed has been paid.</p>
            </section>
          ) : c.deadlinePassed ? (
            <Notice title="Deadline passed" body="Unclaimed ETH from this snapshot has moved to the Safe for a $BALLAST v2 buyback." />
          ) : (
            <section className="card p-5">
              <h2 className="section-label">Burn v1, receive ETH</h2>
              <p className="mt-2 text-sm text-text-secondary">
                Burn any amount up to what you currently hold. Burning less than your full snapshot balance pays the
                same proportion of your ETH entitlement — you can come back and burn more later. Partial claims sum
                to exactly your full entitlement, with no dust lost.
              </p>

              <div className="mt-4">
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={pct}
                  onChange={(e) => setPct(Number(e.target.value))}
                  className="w-full accent-green"
                />
                <div className="mt-1 flex justify-between text-xs text-text-faint">
                  <span>1%</span>
                  <span className="tabular-nums text-text-secondary">{pct}%</span>
                  <span>100%</span>
                </div>
              </div>

              {c.phase === "success" ? (
                <div className="mt-4 space-y-2 text-center">
                  <p className="text-sm text-green">Claim confirmed — ETH is in your wallet.</p>
                  {c.txHash && (
                    <a className="text-xs text-text-faint hover:text-text-secondary" href={`${EXPLORER}/tx/${c.txHash}`} target="_blank" rel="noreferrer">
                      View on Blockscout ↗
                    </a>
                  )}
                  <div>
                    <button className="text-xs text-text-faint hover:text-text-secondary" onClick={c.reset}>
                      Done
                    </button>
                  </div>
                </div>
              ) : net.wrongNetwork ? (
                <button className="btn-primary mt-4 w-full sm:w-auto" disabled={net.isSwitching} onClick={() => void net.switchToRobinhood()}>
                  {net.isSwitching ? "Switching…" : `Switch to ${net.targetChain.name}`}
                </button>
              ) : (
                <button
                  className="btn-primary mt-4 w-full sm:w-auto"
                  disabled={
                    c.phase === "approving" ||
                    c.phase === "claiming" ||
                    c.v1Balance === undefined ||
                    c.v1Balance === 0n ||
                    c.remaining === undefined ||
                    c.remaining <= 0n
                  }
                  onClick={() => {
                    if (c.remaining === undefined || c.v1Balance === undefined) return;
                    const want = (c.remaining * BigInt(pct)) / 100n;
                    const amount = want > c.v1Balance ? c.v1Balance : want;
                    void c.claim(amount);
                  }}
                >
                  {c.phase === "approving"
                    ? "Approving…"
                    : c.phase === "claiming"
                      ? "Claiming…"
                      : c.v1Balance === 0n
                        ? "No v1 balance to burn"
                        : `Burn ${pct}% and claim`}
                </button>
              )}
              {c.error && <p className="mt-2 text-xs text-negative">{c.error}</p>}
            </section>
          )}

          <p className="max-w-2xl text-xs text-text-faint">
            Sold v1 since the snapshot? You can only ever burn what you currently hold, which caps how much of your
            entitlement you can reach. Bought more v1 since the snapshot? Burning beyond your original snapshot
            balance gets nothing extra — entitlement is fixed at the snapshot, not your current balance.
          </p>

          <section className="card p-5">
            <h2 className="section-label">The snapshot</h2>
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-text-faint">Block</dt>
                <dd className="tabular-nums text-text-primary">73,030,228</dd>
              </div>
              <div>
                <dt className="text-xs text-text-faint">Time (UTC)</dt>
                <dd className="text-text-primary">2026-09-26 11:00:00</dd>
              </div>
              <div>
                <dt className="text-xs text-text-faint">Price used</dt>
                <dd className="text-text-primary">$0.000007100633157926953 / v1 token (TWAP)</dd>
              </div>
              <div>
                <dt className="text-xs text-text-faint">ETH/USD used</dt>
                <dd className="text-text-primary">$2,686.81 (at the snapshot block)</dd>
              </div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <a className="text-green underline underline-offset-2" href="/data/v1-claim-merkle.json" target="_blank" rel="noreferrer">
                Claim data (JSON) ↗
              </a>
            </div>
          </section>

          <Meander className="opacity-60" />
        </>
      )}
    </div>
  );
}

function Deadline({ deadline, now }: { deadline?: bigint; now: number }) {
  const remaining = deadline !== undefined && now > 0 ? Number(deadline) - now : undefined;
  const label =
    remaining === undefined
      ? "—"
      : remaining <= 0
        ? "Passed"
        : remaining > 86400
          ? `${Math.ceil(remaining / 86400)}d left`
          : `${Math.ceil(remaining / 3600)}h left`;
  return <Figure label="Deadline" value={label} sub="30 days from launch" />;
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

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <Meander className="mx-auto mb-5 max-w-[120px] opacity-70" />
      <h2 className="font-serif font-semibold text-bone">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">{body}</p>
    </div>
  );
}
