"use client";

import { useEffect, useState } from "react";
import { BaseError, ContractFunctionRevertedError, formatEther, getAbiItem, type Address, type Log } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { feeRouterAbi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
import { pollReceipt } from "@/lib/waitForReceipt";
import { decodeTxError } from "@/lib/txError";
import { backfillLogs } from "@/lib/eventBackfill";
import { useFeeRouter, type FeeRouterState } from "@/hooks/useFeeRouter";
import type { FeeSplitBps } from "@/hooks/useFeeRouterLaunchRunner";
import { FeesSection } from "@/components/app/create/FeesSection";
import { routeRevertReason, needsBuybackWire } from "@/lib/feeRouter";

const CHAIN_ID = activeChain.id;
type Phase = "idle" | "pending" | "confirming" | "error" | "done";

type RoutedRow = { txHash: `0x${string}`; total: bigint; toCreator: bigint; toTreasury: bigint; toBuyback: bigint; toRewards: bigint };

/**
 * Creator-only: schedule a new split (7-day delay, same rule as everyone) and
 * trigger route() manually. Gated on the CONNECTED wallet matching the
 * router's realCreator — everyone else already sees FeeRouterCard, which is
 * the read-only half of this.
 */
export function FeeRouterDashboard({ token }: { token?: Address }) {
  const { address: account } = useAccount();
  const { router, state, refetch } = useFeeRouter(token);
  const isCreator = Boolean(account && state && account.toLowerCase() === state.realCreator.toLowerCase());

  if (!router || !state || !isCreator) return null;
  return <DashboardBody router={router} state={state} refetch={refetch} />;
}

function DashboardBody({ router, state, refetch }: { router: Address; state: FeeRouterState; refetch: () => void }) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { address: account } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const [split, setSplit] = useState<FeeSplitBps>({
    creatorBps: state.creatorBps,
    treasuryBps: state.treasuryBps,
    buybackBps: state.buybackBps,
    rewardsBps: state.rewardsBps,
  });
  const [schedulePhase, setSchedulePhase] = useState<Phase>("idle");
  const [scheduleErr, setScheduleErr] = useState<string>();
  const [routePhase, setRoutePhase] = useState<Phase>("idle");
  const [routeErr, setRouteErr] = useState<string>();
  const [wirePhase, setWirePhase] = useState<Phase>("idle");
  const [wireErr, setWireErr] = useState<string>();
  // Route preflight: undefined = still checking; "" = routable; non-empty = the
  // decoded on-chain reason route() would revert with right now.
  const [routeBlock, setRouteBlock] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<RoutedRow[]>([]);

  const showWire = needsBuybackWire(state);

  // Simulate route() before offering the button, so we never show "Ready now"
  // for a call that would revert (e.g. no fees yet = NothingToRoute). Re-runs on
  // state changes and after a successful route/wire.
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      const now = Math.floor(Date.now() / 1000);
      const readyAt = Number(state.readyAt);
      try {
        await publicClient.simulateContract({
          address: router,
          abi: feeRouterAbi,
          functionName: "route",
          args: [0n, 0n, 0n],
          account: account ?? state.realCreator,
        });
        if (!cancelled) setRouteBlock(""); // simulation passed → routable
      } catch (e) {
        let errName: string | undefined;
        if (e instanceof BaseError) {
          const rev = e.walk((err) => err instanceof ContractFunctionRevertedError);
          if (rev instanceof ContractFunctionRevertedError) errName = rev.data?.errorName ?? rev.signature;
        }
        if (!cancelled) setRouteBlock(routeRevertReason(errName, now, readyAt));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, router, account, state.readyAt, state.creatorBps, state.treasuryBps, state.buybackBps, state.rewardsBps, routePhase, wirePhase]);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      const latest = await publicClient.getBlockNumber();
      const { logs } = await backfillLogs(publicClient, {
        address: router,
        event: getAbiItem({ abi: feeRouterAbi, name: "Routed" }),
        fromBlock: 0n,
        toBlock: latest,
      });
      if (cancelled) return;
      const rows = (logs as Log[])
        .slice(-20)
        .reverse()
        .map((l) => {
          const a = (l as unknown as { args: { total: bigint; toCreator: bigint; toTreasury: bigint; toBuyback: bigint; toRewards: bigint } }).args;
          return { txHash: l.transactionHash as `0x${string}`, ...a };
        });
      setHistory(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, router]);

  async function saveSplit() {
    if (!publicClient) return;
    setScheduleErr(undefined);
    setSchedulePhase("pending");
    let hash: `0x${string}`;
    try {
      hash = await writeContractAsync({
        address: router,
        abi: feeRouterAbi,
        functionName: "scheduleSplit",
        args: [split.creatorBps, split.treasuryBps, split.buybackBps, split.rewardsBps],
        chainId: CHAIN_ID,
      });
    } catch (e) {
      setScheduleErr(decodeTxError(e));
      setSchedulePhase("error");
      return;
    }
    setSchedulePhase("confirming");
    const outcome = await pollReceipt(publicClient, hash);
    setSchedulePhase(outcome.status === "reverted" ? "error" : "done");
    if (outcome.status === "reverted") setScheduleErr("Transaction reverted on-chain.");
    else refetch();
  }

  async function wireBuyback() {
    if (!publicClient) return;
    setWireErr(undefined);
    setWirePhase("pending");
    let hash: `0x${string}`;
    try {
      hash = await writeContractAsync({ address: router, abi: feeRouterAbi, functionName: "wireBuybackPool", chainId: CHAIN_ID });
    } catch (e) {
      setWireErr(decodeTxError(e));
      setWirePhase("error");
      return;
    }
    setWirePhase("confirming");
    const outcome = await pollReceipt(publicClient, hash);
    setWirePhase(outcome.status === "reverted" ? "error" : "done");
    if (outcome.status === "reverted") setWireErr("Transaction reverted on-chain.");
    else refetch();
  }

  async function routeNow() {
    if (!publicClient) return;
    setRouteErr(undefined);
    setRoutePhase("pending");
    let hash: `0x${string}`;
    try {
      hash = await writeContractAsync({ address: router, abi: feeRouterAbi, functionName: "route", args: [0n, 0n, 0n], chainId: CHAIN_ID });
    } catch (e) {
      setRouteErr(decodeTxError(e));
      setRoutePhase("error");
      return;
    }
    setRoutePhase("confirming");
    const outcome = await pollReceipt(publicClient, hash);
    setRoutePhase(outcome.status === "reverted" ? "error" : "done");
    if (outcome.status === "reverted") setRouteErr("Transaction reverted on-chain.");
    else refetch();
  }

  const scheduleBusy = schedulePhase === "pending" || schedulePhase === "confirming";
  const routeBusy = routePhase === "pending" || routePhase === "confirming";
  const wireBusy = wirePhase === "pending" || wirePhase === "confirming";
  const checking = routeBlock === undefined;
  const routable = routeBlock === "";

  return (
    <section className="space-y-4">
      <div>
        <h2 className="section-label mb-2">Change split</h2>
        <FeesSection split={split} onChange={setSplit} />
        <button className="btn-primary mt-3 w-full" onClick={saveSplit} disabled={scheduleBusy}>
          {schedulePhase === "pending" ? "Confirm in your wallet…" : schedulePhase === "confirming" ? "Waiting…" : "Save split (7-day delay)"}
        </button>
        {schedulePhase === "done" && <p className="mt-2 text-xs text-green">Scheduled ✓ — applies in 7 days.</p>}
        {scheduleErr && <p className="mt-2 text-xs text-negative">{scheduleErr}</p>}
      </div>

      {showWire && (
        <div className="card p-5">
          <h2 className="section-label">Wire buyback pool</h2>
          <p className="mt-1 text-xs text-text-faint">
            Your split sends fees to buyback &amp; burn, but this token&apos;s buyback pool isn&apos;t wired yet. Anyone
            can wire it once the token has graduated — do it now so route() can buy and burn.
          </p>
          <button className="btn-primary mt-3 w-full" onClick={wireBuyback} disabled={wireBusy}>
            {wirePhase === "pending" ? "Confirm in your wallet…" : wirePhase === "confirming" ? "Wiring…" : "Wire buyback pool"}
          </button>
          {wirePhase === "done" && <p className="mt-2 text-xs text-green">Wired ✓</p>}
          {wireErr && <p className="mt-2 text-xs text-negative">{wireErr}</p>}
        </div>
      )}

      <div className="card p-5">
        <h2 className="section-label">Route now</h2>
        <p className="mt-1 text-xs text-text-faint">
          {checking ? "Checking…" : routable ? "Ready — distributes accrued fees across the buckets." : routeBlock}
        </p>
        <button className="btn-secondary mt-3 w-full" onClick={routeNow} disabled={routeBusy || checking || !routable}>
          {routePhase === "pending" ? "Confirm in your wallet…" : routePhase === "confirming" ? "Routing…" : "Route now"}
        </button>
        {routePhase === "done" && <p className="mt-2 text-xs text-green">Routed ✓</p>}
        {routeErr && <p className="mt-2 text-xs text-negative">{routeErr}</p>}
      </div>

      {history.length > 0 && (
        <div className="card p-5">
          <h2 className="section-label">History</h2>
          <ul className="mt-2 space-y-2 text-xs">
            {history.map((h) => (
              <li key={h.txHash} className="flex items-center justify-between text-text-secondary">
                <a
                  href={`${activeChain.blockExplorers.default.url}/tx/${h.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono underline underline-offset-2"
                >
                  {h.txHash.slice(0, 10)}…
                </a>
                <span className="font-mono text-text-primary">{formatEther(h.total)} WETH</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
