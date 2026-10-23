"use client";

import { useEffect, useState } from "react";
import { BaseError, ContractFunctionRevertedError, getAbiItem, type Address, type Log } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { feeRouterAbi, feeRouterV2Abi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
import { pollReceipt } from "@/lib/waitForReceipt";
import { decodeTxError } from "@/lib/txError";
import { backfillLogs } from "@/lib/eventBackfill";
import { useFeeRouter, type FeeRouterState } from "@/hooks/useFeeRouter";
import type { FeeSplitBps } from "@/hooks/useFeeRouterLaunchRunner";
import { FeesSection } from "@/components/app/create/FeesSection";
import { TokenAmount } from "@/components/app/TokenAmount";
import { routeRevertReason, needsBuybackWire, needsParentWire } from "@/lib/feeRouter";

const CHAIN_ID = activeChain.id;
type Phase = "idle" | "pending" | "confirming" | "error" | "done";

type RoutedRow = { txHash: `0x${string}`; total: bigint };

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

  // v2 routers have the 5th (parentBurn) bucket: scheduleSplit/route take an extra
  // arg and there's a wireParentPool step. Pick the matching ABI + arities.
  const abi = state.isV2 ? feeRouterV2Abi : feeRouterAbi;
  const routeArgs = (state.isV2 ? [0n, 0n, 0n, 0n] : [0n, 0n, 0n]) as
    | readonly [bigint, bigint, bigint]
    | readonly [bigint, bigint, bigint, bigint];

  const [split, setSplit] = useState<FeeSplitBps>({
    creatorBps: state.creatorBps,
    treasuryBps: state.treasuryBps,
    buybackBps: state.buybackBps,
    parentBurnBps: state.parentBurnBps,
    rewardsBps: state.rewardsBps,
    parent: state.parent,
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
  const [parentWirePhase, setParentWirePhase] = useState<Phase>("idle");
  const [parentWireErr, setParentWireErr] = useState<string>();

  const showWire = needsBuybackWire(state);
  const showParentWire = needsParentWire({
    hasParent: Boolean(state.parent),
    parentWired: state.parentWired,
    parentBurnBps: state.parentBurnBps,
    hasPendingSplit: state.hasPendingSplit,
    pendingParentBurnBps: state.pendingParentBurnBps,
  });

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
          abi,
          functionName: "route",
          args: routeArgs,
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
        event: getAbiItem({ abi, name: "Routed" }),
        fromBlock: 0n,
        toBlock: latest,
      });
      if (cancelled) return;
      const rows = (logs as Log[])
        .slice(-20)
        .reverse()
        .map((l) => {
          const a = (l as unknown as { args: { total: bigint } }).args;
          return { txHash: l.transactionHash as `0x${string}`, total: a.total };
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
      if (state.isV2) {
        hash = await writeContractAsync({
          address: router,
          abi: feeRouterV2Abi,
          functionName: "scheduleSplit",
          args: [split.creatorBps, split.treasuryBps, split.buybackBps, split.parentBurnBps, split.rewardsBps],
          chainId: CHAIN_ID,
        });
      } else {
        hash = await writeContractAsync({
          address: router,
          abi: feeRouterAbi,
          functionName: "scheduleSplit",
          args: [split.creatorBps, split.treasuryBps, split.buybackBps, split.rewardsBps],
          chainId: CHAIN_ID,
        });
      }
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
      hash = await writeContractAsync({ address: router, abi, functionName: "wireBuybackPool", chainId: CHAIN_ID });
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

  async function wireParent() {
    if (!publicClient) return;
    setParentWireErr(undefined);
    setParentWirePhase("pending");
    let hash: `0x${string}`;
    try {
      hash = await writeContractAsync({ address: router, abi: feeRouterV2Abi, functionName: "wireParentPool", chainId: CHAIN_ID });
    } catch (e) {
      setParentWireErr(decodeTxError(e));
      setParentWirePhase("error");
      return;
    }
    setParentWirePhase("confirming");
    const outcome = await pollReceipt(publicClient, hash);
    setParentWirePhase(outcome.status === "reverted" ? "error" : "done");
    if (outcome.status === "reverted") setParentWireErr("Transaction reverted on-chain.");
    else refetch();
  }

  async function routeNow() {
    if (!publicClient) return;
    setRouteErr(undefined);
    setRoutePhase("pending");
    let hash: `0x${string}`;
    try {
      hash = await writeContractAsync({ address: router, abi, functionName: "route", args: routeArgs, chainId: CHAIN_ID });
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
  const parentWireBusy = parentWirePhase === "pending" || parentWirePhase === "confirming";
  const checking = routeBlock === undefined;
  const routable = routeBlock === "";

  return (
    <section className="space-y-4">
      <div>
        <h2 className="section-label mb-2">Change split</h2>
        <FeesSection split={split} onChange={setSplit} allowParent={state.isV2 && Boolean(state.parent)} lockParent />
        <button className="btn-primary mt-3 w-full" onClick={saveSplit} disabled={scheduleBusy}>
          {schedulePhase === "pending" ? "Confirm in your wallet…" : schedulePhase === "confirming" ? "Waiting…" : state.isV2 ? "Save split" : "Save split (7-day delay)"}
        </button>
        {state.isV2 && (
          <p className="mt-2 text-xs text-text-faint">
            Lowering your own share applies instantly. Anything else takes effect 7 days after you schedule it.
          </p>
        )}
        {schedulePhase === "done" && (
          <p className="mt-2 text-xs text-green">Saved ✓{state.isV2 ? "" : " — applies in 7 days."}</p>
        )}
        {scheduleErr && <p className="mt-2 text-xs text-negative">{scheduleErr}</p>}
      </div>

      {showParentWire && (
        <div className="card p-5">
          <h2 className="section-label">Wire parent pool</h2>
          <p className="mt-1 text-xs text-text-faint">
            Your split sends fees to burning the parent token, but its pool isn&apos;t wired yet. Anyone can wire it once
            the parent has a live WETH pool — do it now so route() can buy and burn the parent.
          </p>
          <button className="btn-primary mt-3 w-full" onClick={wireParent} disabled={parentWireBusy}>
            {parentWirePhase === "pending" ? "Confirm in your wallet…" : parentWirePhase === "confirming" ? "Wiring…" : "Wire parent pool"}
          </button>
          {parentWirePhase === "done" && <p className="mt-2 text-xs text-green">Wired ✓</p>}
          {parentWireErr && <p className="mt-2 text-xs text-negative">{parentWireErr}</p>}
        </div>
      )}

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
              <li key={h.txHash} className="flex items-center justify-between gap-3 text-text-secondary">
                <a
                  href={`${activeChain.blockExplorers.default.url}/tx/${h.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 font-mono underline underline-offset-2"
                >
                  {h.txHash.slice(0, 10)}…
                </a>
                <TokenAmount value={h.total} symbol="WETH" className="text-text-primary" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
