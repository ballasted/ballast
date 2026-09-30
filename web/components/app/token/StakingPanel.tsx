"use client";

import { useState } from "react";
import { formatEther, formatUnits, parseUnits, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { holderStakingVaultAbi, erc20Abi } from "@/lib/abis";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { pollReceipt } from "@/lib/waitForReceipt";
import { decodeTxError } from "@/lib/txError";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useFeeRouter } from "@/hooks/useFeeRouter";
import { ConnectButton } from "@/components/app/ConnectButton";

const CHAIN_ID = activeChain.id;
type Phase = "idle" | "pending" | "confirming" | "lost" | "error" | "done";

/**
 * Opt-in staking for a token's holder-rewards bucket. Renders nothing unless
 * this token has a FeeRouter with rewardsBps > 0 (or someone is already
 * staked — a creator can turn the bucket off later, but existing stakers'
 * position must stay visible). Rewards are paid in WETH; no APR is ever shown
 * (copy rule — rewards depend entirely on what the creator routes here and
 * are never promised).
 */
export function StakingPanel({ token, symbol }: { token?: Address; symbol?: string }) {
  const { state } = useFeeRouter(token);
  const { address: account } = useAccount();
  const { wrongNetwork, switchToRobinhood, isSwitching } = useNetworkGuard();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const [tab, setTab] = useState<"stake" | "unstake">("stake");
  const [amountStr, setAmountStr] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>();

  const vault = state?.stakingVault;

  const balRes = useReadContracts({
    allowFailure: true,
    contracts:
      vault && token
        ? ([
            { address: token, abi: erc20Abi, functionName: "balanceOf", args: account ? [account] : undefined, chainId: CHAIN_ID },
            { address: vault, abi: holderStakingVaultAbi, functionName: "balanceOf", args: account ? [account] : undefined, chainId: CHAIN_ID },
            { address: vault, abi: holderStakingVaultAbi, functionName: "claimable", args: account ? [account] : undefined, chainId: CHAIN_ID },
            { address: vault, abi: holderStakingVaultAbi, functionName: "totalRewardsNotified", chainId: CHAIN_ID },
            { address: token, abi: erc20Abi, functionName: "allowance", args: account ? [account, vault] : undefined, chainId: CHAIN_ID },
          ] as const)
        : [],
    query: liveQuery(Boolean(vault && account)),
  });
  const walletBalance = balRes.data?.[0]?.status === "success" ? (balRes.data[0].result as bigint) : 0n;
  const staked = balRes.data?.[1]?.status === "success" ? (balRes.data[1].result as bigint) : 0n;
  const claimable = balRes.data?.[2]?.status === "success" ? (balRes.data[2].result as bigint) : 0n;
  const totalRewards = balRes.data?.[3]?.status === "success" ? (balRes.data[3].result as bigint) : 0n;
  const allowance = balRes.data?.[4]?.status === "success" ? (balRes.data[4].result as bigint) : 0n;

  // Hidden entirely when there's no reason to show it — no rewards bucket and
  // nobody has ever staked (CLAUDE.md: when in doubt, remove).
  if (!state || !vault || (state.rewardsBps === 0 && staked === 0n)) return null;

  let amount = 0n;
  try {
    if (amountStr) amount = parseUnits(amountStr, 18);
  } catch {
    amount = 0n;
  }
  const maxAmount = tab === "stake" ? walletBalance : staked;
  const validAmount = amount > 0n && amount <= maxAmount;
  const needsApproval = tab === "stake" && amount > 0n && allowance < amount;

  async function send(write: () => Promise<`0x${string}`>) {
    if (!publicClient) return;
    setErr(undefined);
    setPhase("pending");
    let hash: `0x${string}`;
    try {
      hash = await write();
    } catch (e) {
      setErr(decodeTxError(e));
      setPhase("error");
      return;
    }
    setPhase("confirming");
    const outcome = await pollReceipt(publicClient, hash);
    if (outcome.status === "lost") return setPhase("lost");
    if (outcome.status === "reverted") {
      setErr("Transaction reverted on-chain.");
      return setPhase("error");
    }
    setPhase("done");
    void balRes.refetch();
  }

  async function approve() {
    await send(() =>
      writeContractAsync({ address: token!, abi: erc20Abi, functionName: "approve", args: [vault!, amount], chainId: CHAIN_ID }),
    );
  }
  async function stake() {
    await send(() => writeContractAsync({ address: vault!, abi: holderStakingVaultAbi, functionName: "stake", args: [amount], chainId: CHAIN_ID }));
  }
  async function unstake() {
    await send(() => writeContractAsync({ address: vault!, abi: holderStakingVaultAbi, functionName: "unstake", args: [amount], chainId: CHAIN_ID }));
  }
  async function claim() {
    await send(() => writeContractAsync({ address: vault!, abi: holderStakingVaultAbi, functionName: "claim", chainId: CHAIN_ID }));
  }

  const busy = phase === "pending" || phase === "confirming";

  return (
    <section className="card space-y-4 p-5">
      <h2 className="section-label">Stake ${symbol ?? "TOKEN"}</h2>

      <div className="grid grid-cols-2 gap-3 text-center">
        <Stat label="Staked" value={`${formatEther(staked)} ${symbol ?? ""}`} />
        <Stat label="Claimable" value={`${formatEther(claimable)} WETH`} />
      </div>
      <div className="text-center text-xs text-text-faint">Rewards paid, all-time: {formatEther(totalRewards)} WETH</div>

      {!account ? (
        <ConnectButton />
      ) : wrongNetwork ? (
        <button className="btn-primary w-full" onClick={() => void switchToRobinhood()} disabled={isSwitching}>
          {isSwitching ? "Switching…" : "Switch to Robinhood Chain"}
        </button>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 rounded-card border border-border p-1">
            {(["stake", "unstake"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTab(t);
                  setAmountStr("");
                }}
                className={`tab-segment border ${tab === t ? "tab-active" : "tab-idle"}`}
              >
                {t === "stake" ? "Stake" : "Unstake"}
              </button>
            ))}
          </div>

          <label className="block">
            <div className="mb-1 flex justify-between text-xs text-text-secondary">
              <span>Amount</span>
              <span>
                Balance: {formatUnits(maxAmount, 18)} {symbol ?? ""}
              </span>
            </div>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                inputMode="decimal"
                placeholder="0.0"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
              />
              <button type="button" className="btn-secondary shrink-0 px-3" onClick={() => setAmountStr(formatUnits(maxAmount, 18))}>
                Max
              </button>
            </div>
          </label>

          {needsApproval ? (
            <button className="btn-primary w-full" onClick={approve} disabled={busy || !validAmount}>
              {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Approving…" : "Approve"}
            </button>
          ) : (
            <button className="btn-primary w-full" onClick={tab === "stake" ? stake : unstake} disabled={busy || !validAmount}>
              {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Waiting…" : tab === "stake" ? "Stake" : "Unstake"}
            </button>
          )}
          <button className="btn-secondary w-full" onClick={claim} disabled={busy || claimable === 0n}>
            Claim
          </button>
        </>
      )}

      {err && <p className="text-xs text-negative">{err}</p>}

      <p className="text-xs text-text-faint">
        Rewards come only from trading fees the creator routes here. They can change or stop.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-text-faint">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-text-primary">{value}</div>
    </div>
  );
}
