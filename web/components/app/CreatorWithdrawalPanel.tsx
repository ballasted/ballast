"use client";

import { useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { projectTreasuryAbi, erc20Abi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
import { pollReceipt } from "@/lib/waitForReceipt";
import { decodeTxError } from "@/lib/txError";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { formatDuration } from "@/lib/format";
import { formatEt } from "@/lib/marketHours";
import { ConnectButton } from "@/components/app/ConnectButton";
import type { PendingWithdrawal } from "@/hooks/useBacking";

type AssetView = { asset: Address; withdrawableBalance: bigint; assetDecimals: number };
type Phase = "idle" | "confirm" | "pending" | "confirming" | "lost" | "error" | "done";

const CHAIN_ID = activeChain.id;

/**
 * Creator-only withdrawal controls for a creator's OWN treasury deposit
 * (`ProjectTreasury.creatorWithdrawable` — never third-party locked funds,
 * there is no function anywhere that can move those). Renders nothing unless
 * the CONNECTED wallet is this launch's creator — everyone else already sees
 * the pending-withdrawal banner (PendingWithdrawalBanner) elsewhere on the
 * page, which is the "impossible to miss" half of the notice-period design;
 * this component is only the actions, not the disclosure.
 */
export function CreatorWithdrawalPanel({
  treasury,
  creator,
  assets,
  noticePeriod,
  pending,
  symbol,
  now,
}: {
  treasury?: Address;
  creator?: Address;
  assets: AssetView[];
  noticePeriod?: bigint;
  pending?: PendingWithdrawal;
  symbol?: string;
  now: number;
}) {
  const { address: account, isConnected } = useAccount();
  const isCreator = Boolean(account && creator && account.toLowerCase() === creator.toLowerCase());

  if (!treasury || !creator || !isCreator) return null;

  return pending ? (
    <ActiveWithdrawal treasury={treasury} pending={pending} now={now} />
  ) : (
    <AnnounceForm treasury={treasury} assets={assets} noticePeriod={noticePeriod} symbol={symbol} isConnected={isConnected} />
  );
}

function ActiveWithdrawal({ treasury, pending, now }: { treasury: Address; pending: PendingWithdrawal; now: number }) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<Phase>("idle");
  const [hash, setHash] = useState<`0x${string}`>();
  const [err, setErr] = useState<string>();
  const explorer = activeChain.blockExplorers.default.url;

  const symbolRes = useReadContracts({
    contracts: [{ address: pending.asset, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID }],
  });
  const decimalsRes = useReadContracts({
    contracts: [{ address: pending.asset, abi: erc20Abi, functionName: "decimals", chainId: CHAIN_ID }],
  });
  const assetSymbol = symbolRes.data?.[0]?.status === "success" ? (symbolRes.data[0].result as string) : "asset";
  const assetDecimals = decimalsRes.data?.[0]?.status === "success" ? (decimalsRes.data[0].result as number) : 18;

  const unlockAt = Number(pending.unlockAt);
  const remaining = now > 0 ? unlockAt - now : 0;
  const executable = now > 0 && remaining <= 0;

  async function run(fn: "executeWithdrawal" | "cancelWithdrawal") {
    setErr(undefined);
    setPhase("pending");
    let h: `0x${string}`;
    try {
      h = await writeContractAsync({
        address: treasury,
        abi: projectTreasuryAbi,
        functionName: fn,
        args: [pending.id],
        chainId: CHAIN_ID,
      });
    } catch (e) {
      setErr(decodeTxError(e));
      setPhase("error");
      return;
    }
    setHash(h);
    setPhase("confirming");
    if (!publicClient) return;
    const outcome = await pollReceipt(publicClient, h);
    if (outcome.status === "lost") return setPhase("lost");
    if (outcome.status === "reverted") {
      setErr("Transaction reverted on-chain.");
      return setPhase("error");
    }
    setPhase("done");
  }

  if (phase === "done") {
    return (
      <div className="note note-positive p-4">
        <div className="font-semibold text-green">Done ✓</div>
        <p className="mt-1 text-sm text-text-secondary">Reload to see the updated balance.</p>
        <button className="btn-primary mt-3 w-full" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }

  return (
    <section className="card border-accent p-5">
      <h2 className="section-label">Creator deposit — withdrawal announced</h2>
      <p className="mt-2 text-sm text-text-secondary">
        {formatUnits(pending.amount, assetDecimals)} {assetSymbol} queued to withdraw.
      </p>
      <p className="mt-1 text-sm">
        {executable ? (
          <span className="font-semibold text-green">Notice period elapsed — executable now.</span>
        ) : (
          <>
            Executable in <span className="font-semibold text-text-primary">{formatDuration(remaining)}</span>, on{" "}
            {formatEt(unlockAt)}.
          </>
        )}
      </p>
      <div className="mt-4 flex gap-2">
        <button
          className="btn-primary flex-1"
          onClick={() => run("executeWithdrawal")}
          disabled={!executable || phase === "pending" || phase === "confirming"}
        >
          {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Waiting…" : "Execute withdrawal"}
        </button>
        <button
          className="btn-secondary flex-1"
          onClick={() => run("cancelWithdrawal")}
          disabled={phase === "pending" || phase === "confirming"}
        >
          Cancel
        </button>
      </div>
      {phase === "lost" && hash && (
        <p className="mt-2 text-xs text-warning">
          Lost track of this transaction — check{" "}
          <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="underline">
            Blockscout
          </a>{" "}
          before retrying.
        </p>
      )}
      {err && <p className="mt-2 text-xs text-negative">{err}</p>}
    </section>
  );
}

function AnnounceForm({
  treasury,
  assets,
  noticePeriod,
  symbol,
  isConnected,
}: {
  treasury: Address;
  assets: AssetView[];
  noticePeriod?: bigint;
  symbol?: string;
  isConnected: boolean;
}) {
  const { wrongNetwork, switchToRobinhood, isSwitching } = useNetworkGuard();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const withdrawable = useMemo(() => assets.filter((a) => a.withdrawableBalance > 0n), [assets]);
  const [open, setOpen] = useState(false);
  const [assetIdx, setAssetIdx] = useState(0);
  const [amountStr, setAmountStr] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [hash, setHash] = useState<`0x${string}`>();
  const [err, setErr] = useState<string>();

  const symbolRes = useReadContracts({
    allowFailure: true,
    contracts: withdrawable.map((a) => ({ address: a.asset, abi: erc20Abi, functionName: "symbol", chainId: CHAIN_ID }) as const),
  });

  if (withdrawable.length === 0) return null;

  const active = withdrawable[assetIdx] ?? withdrawable[0]!;
  const activeSymbol = symbolRes.data?.[assetIdx]?.status === "success" ? (symbolRes.data[assetIdx].result as string) : "asset";
  const maxAmount = formatUnits(active.withdrawableBalance, active.assetDecimals);
  const days = noticePeriod ? Math.round(Number(noticePeriod) / 86400) : undefined;

  let amount = 0n;
  try {
    if (amountStr) amount = parseUnits(amountStr, active.assetDecimals);
  } catch {
    amount = 0n;
  }
  const validAmount = amount > 0n && amount <= active.withdrawableBalance;

  async function announce() {
    setErr(undefined);
    setPhase("pending");
    let h: `0x${string}`;
    try {
      h = await writeContractAsync({
        address: treasury,
        abi: projectTreasuryAbi,
        functionName: "announceWithdrawal",
        args: [active.asset, amount],
        chainId: CHAIN_ID,
      });
    } catch (e) {
      setErr(decodeTxError(e));
      setPhase("error");
      return;
    }
    setHash(h);
    setPhase("confirming");
    if (!publicClient) return;
    const outcome = await pollReceipt(publicClient, h);
    if (outcome.status === "lost") return setPhase("lost");
    if (outcome.status === "reverted") {
      setErr("Transaction reverted on-chain.");
      return setPhase("error");
    }
    setPhase("done");
  }

  if (phase === "done") {
    return (
      <div className="note note-positive p-4">
        <div className="font-semibold text-green">Withdrawal announced ✓</div>
        <p className="mt-1 text-sm text-text-secondary">Reload to see the countdown.</p>
        <button className="btn-primary mt-3 w-full" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button className="btn-secondary w-full" onClick={() => setOpen(true)}>
        Withdraw creator deposit
      </button>
    );
  }

  return (
    <section className="card border-accent p-5">
      <h2 className="section-label">Withdraw creator deposit</h2>

      {withdrawable.length > 1 && (
        <select
          className="input mt-3"
          value={assetIdx}
          onChange={(e) => {
            setAssetIdx(Number(e.target.value));
            setAmountStr("");
            setConfirmed(false);
          }}
        >
          {withdrawable.map((a, i) => (
            <option key={a.asset} value={i}>
              {symbolRes.data?.[i]?.status === "success" ? (symbolRes.data[i].result as string) : a.asset}
            </option>
          ))}
        </select>
      )}

      <label className="mt-3 block">
        <span className="mb-1.5 block text-sm font-medium text-text-secondary">Amount</span>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            inputMode="decimal"
            placeholder="0.0"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
          />
          <button type="button" className="btn-secondary shrink-0 px-3" onClick={() => setAmountStr(maxAmount)}>
            Max
          </button>
        </div>
        <span className="mt-1 block text-xs text-text-faint">
          Balance: {maxAmount} {activeSymbol}
        </span>
      </label>

      <label className="mt-4 flex items-start gap-2 text-sm text-text-secondary">
        <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        <span>
          This is announced publicly now and can be executed after {days ?? "N"} days. Everyone viewing ${symbol || "this token"}{" "}
          will see it.
        </span>
      </label>

      <p className="mt-3 rounded-input bg-bg px-3 py-2 text-xs text-text-muted">
        Holding ${symbol || "TICKER"} gives no claim, redemption right, or entitlement to these assets.
      </p>

      {!isConnected ? (
        <div className="mt-4">
          <ConnectButton />
        </div>
      ) : wrongNetwork ? (
        <button className="btn-primary mt-4 w-full" onClick={() => void switchToRobinhood()} disabled={isSwitching}>
          {isSwitching ? "Switching…" : "Switch to Robinhood Chain"}
        </button>
      ) : (
        <div className="mt-4 flex gap-2">
          <button className="btn-secondary flex-1" onClick={() => setOpen(false)} disabled={phase === "pending" || phase === "confirming"}>
            Cancel
          </button>
          <button
            className="btn-primary flex-1"
            onClick={announce}
            disabled={!validAmount || !confirmed || phase === "pending" || phase === "confirming"}
          >
            {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Waiting…" : "Announce withdrawal"}
          </button>
        </div>
      )}
      {phase === "lost" && hash && <p className="mt-2 text-xs text-warning">Lost track of this transaction — check Blockscout before retrying.</p>}
      {err && <p className="mt-2 text-xs text-negative">{err}</p>}
    </section>
  );
}
