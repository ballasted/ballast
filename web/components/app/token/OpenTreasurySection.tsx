"use client";

import { useMemo, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { openTreasuryVaultFactoryAbi, openTreasuryVaultAbi, erc20Abi } from "@/lib/abis";
import { OPEN_TREASURY_FACTORY_ADDRESS } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { pollReceipt } from "@/lib/waitForReceipt";
import { decodeTxError } from "@/lib/txError";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useAssets, type AllowedAsset } from "@/hooks/useAssets";
import { useOpenTreasury } from "@/hooks/useOpenTreasury";
import { useOpenTreasuryActivity } from "@/hooks/useOpenTreasuryActivity";
import { useAccruedFees } from "@/hooks/useAccruedFees";
import { formatUsd, formatDuration, shortAddress } from "@/lib/format";
import { ConnectButton } from "@/components/app/ConnectButton";
import { cn } from "@/lib/cn";

const CHAIN_ID = activeChain.id;
type Phase = "idle" | "pending" | "confirming" | "lost" | "error" | "done";
const CONFIRM_TEXT =
  "You can withdraw your deposit after the minimum holding time. You earn a variable share of trading fees, which can be zero. This is not a promise of returns. The value of deposited assets can go down.";

function fmt(v: bigint, decimals: number, opts?: Intl.NumberFormatOptions): string {
  return Number(formatUnits(v, decimals)).toLocaleString("en", { maximumFractionDigits: 6, ...opts });
}

/**
 * Open Treasury — permissionless deposits earning a variable share of trading
 * fees. Entirely behind the NEXT_PUBLIC_OPEN_TREASURY_ENABLED feature flag
 * (default off, see lib/contracts.ts) — renders nothing when disabled or
 * unconfigured. Rule 18: three separate figures, never folded together.
 */
export function OpenTreasurySection({ token, creator, symbol }: { token?: Address; creator?: Address; symbol?: string }) {
  const { address: account } = useAccount();
  const { assets: listedAssets, isConfigured: registryConfigured } = useAssets();
  const ot = useOpenTreasury(token, listedAssets);
  const activity = useOpenTreasuryActivity(ot.vault);
  const isCreator = Boolean(account && creator && account.toLowerCase() === creator.toLowerCase());

  if (!ot.enabled || !registryConfigured || !token) return null;

  return (
    <section className="card space-y-5 p-5">
      <div>
        <h2 className="section-label">Open Treasury</h2>
        <p className="mt-1 text-xs text-text-faint">
          Anyone can deposit a listed asset and earn a variable share of trading fees. Not creator-funded ballast —
          separate, always withdrawable by whoever deposited it.
        </p>
      </div>

      <ThreeFigures backing={ot.backing} />

      <NetFlowRow net24h={activity.net24h} net7d={activity.net7d} listedAssets={listedAssets} status={activity.status} />

      <div className="grid gap-4 md:grid-cols-2">
        <DepositWithdrawPanel
          token={token}
          vault={ot.vault}
          predictedVault={ot.predictedVault}
          listedAssets={listedAssets}
          positions={ot.positions}
          minHoldTime={ot.minHoldTime}
          symbol={symbol}
          onDone={ot.refetchAll}
        />
        <RewardsPanel
          vault={ot.vault}
          rewardAsset={ot.rewardAsset}
          earned={ot.earned}
          periodFinish={ot.periodFinish}
          rewardRate={ot.rewardRate}
          totalRewardDeposited={ot.totalRewardDeposited}
          rewardsDuration={ot.rewardsDuration}
          onDone={ot.refetchAll}
        />
      </div>

      {isCreator && ot.vault && <FundRewardsPanel vault={ot.vault} rewardAsset={ot.rewardAsset} onDone={ot.refetchAll} />}

      <AprBlock
        rewardLast7d={activity.rewardLast7d}
        rewardLast30d={activity.rewardLast30d}
        communityWithdrawableUsd={ot.backing?.communityWithdrawableUsd}
        rewardsDuration={ot.rewardsDuration}
        status={activity.status}
      />

      <ContributorList events={activity.events} listedAssets={listedAssets} status={activity.status} />
    </section>
  );
}

// --------------------------------------------------------------------- //
//  Three figures (rule 18)                                               //
// --------------------------------------------------------------------- //

function ThreeFigures({ backing }: { backing?: ReturnType<typeof useOpenTreasury>["backing"] }) {
  return (
    <div className="grid grid-cols-3 gap-3 rounded-card border border-border p-3 text-center">
      <Stat label="Creator-funded treasury" value={backing ? formatUsd(backing.creatorFundedUsd, { compact: true }) : "Unknown"} />
      <Stat
        label="Community deposits — withdrawable"
        value={backing ? formatUsd(backing.communityWithdrawableUsd, { compact: true }) : "Unknown"}
        accent
      />
      <Stat label="Combined total" value={backing ? formatUsd(backing.combinedTotalUsd, { compact: true }) : "Unknown"} />
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className={cn("figure-primary text-base", accent && "text-green")}>{value}</div>
      <div className="mt-0.5 text-[11px] leading-tight text-text-faint">{label}</div>
    </div>
  );
}

function NetFlowRow({
  net24h,
  net7d,
  listedAssets,
  status,
}: {
  net24h: Record<string, { deposited: bigint; withdrawn: bigint }>;
  net7d: Record<string, { deposited: bigint; withdrawn: bigint }>;
  listedAssets: AllowedAsset[];
  status: string;
}) {
  const symbolOf = (asset: string) => listedAssets.find((a) => a.address.toLowerCase() === asset)?.symbol ?? shortAddress(asset);
  const decOf = (asset: string) => listedAssets.find((a) => a.address.toLowerCase() === asset)?.decimals ?? 18;
  const rows = (net: Record<string, { deposited: bigint; withdrawn: bigint }>) =>
    Object.entries(net).map(([asset, n]) => {
      const net_ = n.deposited - n.withdrawn;
      const dec = decOf(asset);
      return `${net_ >= 0n ? "+" : ""}${fmt(net_, dec)} ${symbolOf(asset)}`;
    });

  if (status === "loading" || status === "idle") return <p className="text-xs text-text-faint">Net flow: loading…</p>;
  if (status === "failed") return <p className="text-xs text-text-faint">Net flow: Unknown (event scan unavailable)</p>;

  const r24 = rows(net24h);
  const r7 = rows(net7d);
  return (
    <div className="flex flex-wrap gap-4 text-xs text-text-secondary">
      <span>Net 24h: {r24.length ? r24.join(", ") : "0"}</span>
      <span>Net 7d: {r7.length ? r7.join(", ") : "0"}</span>
      {status === "partial" && <span className="text-text-faint">(partial scan)</span>}
    </div>
  );
}

// --------------------------------------------------------------------- //
//  Deposit / withdraw                                                   //
// --------------------------------------------------------------------- //

function DepositWithdrawPanel({
  token,
  vault,
  predictedVault,
  listedAssets,
  positions,
  minHoldTime,
  symbol,
  onDone,
}: {
  token: Address;
  vault?: Address;
  predictedVault?: Address;
  listedAssets: AllowedAsset[];
  positions: { asset: Address; principal: bigint; unlockAt: bigint }[];
  minHoldTime?: bigint;
  symbol?: string;
  onDone: () => void;
}) {
  const { address: account } = useAccount();
  const { wrongNetwork, switchToRobinhood, isSwitching } = useNetworkGuard();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [assetIdx, setAssetIdx] = useState(0);
  const [amountStr, setAmountStr] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>();

  const targetVault = vault ?? predictedVault;
  const asset = listedAssets[assetIdx];

  const walletBalRes = useReadContract({
    address: asset?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(asset && account) },
  });
  const allowanceRes = useReadContract({
    address: asset?.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: account && targetVault ? [account, targetVault] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(asset && account && targetVault) },
  });
  const walletBalance = (walletBalRes.data as bigint | undefined) ?? 0n;
  const allowance = (allowanceRes.data as bigint | undefined) ?? 0n;

  const position = positions.find((p) => asset && p.asset.toLowerCase() === asset.address.toLowerCase());
  const decimals = asset?.decimals ?? 18;

  let amount = 0n;
  try {
    if (amountStr) amount = parseUnits(amountStr, decimals);
  } catch {
    amount = 0n;
  }

  const minDeposit = asset?.minDeposit ?? 0n;
  const depositValid = mode === "deposit" && amount > 0n && amount >= minDeposit && amount <= walletBalance;
  const now = Math.floor(Date.now() / 1000);
  const withdrawUnlocked = position ? position.unlockAt > 0n && now >= Number(position.unlockAt) : false;
  const withdrawValid = mode === "withdraw" && position && amount > 0n && amount <= position.principal && withdrawUnlocked;
  const needsApproval = mode === "deposit" && amount > 0n && allowance < amount;

  async function run(write: () => Promise<`0x${string}`>) {
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
    setConfirmed(false);
    setAmountStr("");
    onDone();
    void walletBalRes.refetch();
    void allowanceRes.refetch();
  }

  async function approve() {
    if (!asset || !targetVault) return;
    await run(() => writeContractAsync({ address: asset.address, abi: erc20Abi, functionName: "approve", args: [targetVault, amount], chainId: CHAIN_ID }));
  }
  async function deposit() {
    if (!asset) return;
    // getOrCreateVault is idempotent and permissionless — safe to call every
    // time; only the FIRST ever call for this token actually deploys a clone.
    await run(async () => {
      if (!vault && OPEN_TREASURY_FACTORY_ADDRESS) {
        const createHash = await writeContractAsync({
          address: OPEN_TREASURY_FACTORY_ADDRESS,
          abi: openTreasuryVaultFactoryAbi,
          functionName: "getOrCreateVault",
          args: [token],
          chainId: CHAIN_ID,
        });
        if (publicClient) await pollReceipt(publicClient, createHash);
      }
      const resolvedVault = vault ?? predictedVault!;
      return writeContractAsync({ address: resolvedVault, abi: openTreasuryVaultAbi, functionName: "deposit", args: [asset.address, amount], chainId: CHAIN_ID });
    });
  }
  async function withdraw() {
    if (!asset || !vault) return;
    await run(() => writeContractAsync({ address: vault, abi: openTreasuryVaultAbi, functionName: "withdraw", args: [asset.address, amount], chainId: CHAIN_ID }));
  }

  const busy = phase === "pending" || phase === "confirming";
  const days = minHoldTime ? (Number(minHoldTime) / 86400).toFixed(Number(minHoldTime) % 86400 === 0 ? 0 : 1) : "1";

  if (listedAssets.length === 0) {
    return <div className="card border-border p-4 text-sm text-text-muted">No listed assets available to deposit yet.</div>;
  }

  if (phase === "done") {
    return (
      <div className="note note-positive p-4">
        <div className="font-semibold text-green">{mode === "deposit" ? "Deposited ✓" : "Withdrawn ✓"}</div>
        <p className="mt-1 text-sm text-text-secondary">Balances refresh automatically.</p>
        <button className="btn-secondary mt-3 w-full" onClick={() => setPhase("idle")}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="card border-border p-4">
      <div className="mb-3 grid grid-cols-2 gap-2 rounded-card border border-border p-1">
        {(["deposit", "withdraw"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              setAmountStr("");
              setConfirmed(false);
              setErr(undefined);
            }}
            className={cn("tab-segment border", mode === m ? "tab-active" : "tab-idle")}
          >
            {m === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>

      <select
        className="input"
        value={assetIdx}
        onChange={(e) => {
          setAssetIdx(Number(e.target.value));
          setAmountStr("");
          setConfirmed(false);
        }}
      >
        {listedAssets.map((a, i) => (
          <option key={a.address} value={i}>
            {a.symbol ?? shortAddress(a.address)}
          </option>
        ))}
      </select>

      <label className="mt-3 block">
        <div className="mb-1 flex justify-between text-xs text-text-secondary">
          <span>Amount</span>
          <span>
            {mode === "deposit"
              ? `Wallet: ${fmt(walletBalance, decimals)} ${asset?.symbol ?? ""} · min ${fmt(minDeposit, decimals)}`
              : `Deposited: ${fmt(position?.principal ?? 0n, decimals)} ${asset?.symbol ?? ""}`}
          </span>
        </div>
        <div className="flex gap-2">
          <input className="input flex-1" inputMode="decimal" placeholder="0.0" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} />
          <button
            type="button"
            className="btn-secondary shrink-0 px-3"
            onClick={() => setAmountStr(formatUnits(mode === "deposit" ? walletBalance : (position?.principal ?? 0n), decimals))}
          >
            Max
          </button>
        </div>
      </label>

      {mode === "withdraw" && position && position.unlockAt > 0n && !withdrawUnlocked && (
        <p className="mt-2 text-xs text-text-faint">
          Withdrawable in {formatDuration(Number(position.unlockAt) - now)}.
        </p>
      )}

      {mode === "deposit" && (
        <label className="mt-4 flex items-start gap-2 text-sm text-text-secondary">
          <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>{CONFIRM_TEXT.replace("the minimum holding time", `${days} day${days === "1" ? "" : "s"}`)}</span>
        </label>
      )}

      <p className="mt-3 rounded-input bg-bg px-3 py-2 text-xs text-text-muted">
        Holding ${symbol || "TICKER"} gives no claim, redemption right, or entitlement to these assets.
      </p>

      {!account ? (
        <div className="mt-4">
          <ConnectButton />
        </div>
      ) : wrongNetwork ? (
        <button className="btn-primary mt-4 w-full" onClick={() => void switchToRobinhood()} disabled={isSwitching}>
          {isSwitching ? "Switching…" : "Switch to Robinhood Chain"}
        </button>
      ) : mode === "deposit" ? (
        needsApproval ? (
          <button className="btn-primary mt-4 w-full" onClick={approve} disabled={busy || !depositValid || !confirmed}>
            {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Approving…" : `Approve ${asset?.symbol ?? ""}`}
          </button>
        ) : (
          <button className="btn-primary mt-4 w-full" onClick={deposit} disabled={busy || !depositValid || !confirmed}>
            {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Depositing…" : "Deposit"}
          </button>
        )
      ) : (
        <button className="btn-primary mt-4 w-full" onClick={withdraw} disabled={busy || !withdrawValid}>
          {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Withdrawing…" : "Withdraw"}
        </button>
      )}
      {phase === "lost" && <p className="mt-2 text-xs text-warning">Lost track of this transaction — check Blockscout before retrying.</p>}
      {err && <p className="mt-2 text-xs text-negative">{err}</p>}
    </div>
  );
}

// --------------------------------------------------------------------- //
//  Rewards — claimable, claim button, stream status                     //
// --------------------------------------------------------------------- //

function RewardsPanel({
  vault,
  rewardAsset,
  earned,
  periodFinish,
  rewardRate,
  totalRewardDeposited,
  rewardsDuration,
  onDone,
}: {
  vault?: Address;
  rewardAsset?: Address;
  earned: bigint;
  periodFinish?: bigint;
  rewardRate?: bigint;
  totalRewardDeposited?: bigint;
  rewardsDuration?: bigint;
  onDone: () => void;
}) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>();

  const now = Math.floor(Date.now() / 1000);
  const streaming = periodFinish !== undefined && now < Number(periodFinish) && (rewardRate ?? 0n) > 0n;
  const timeLeft = periodFinish !== undefined ? Number(periodFinish) - now : undefined;

  async function claim() {
    if (!vault || !account) return;
    setErr(undefined);
    setPhase("pending");
    let hash: `0x${string}`;
    try {
      hash = await writeContractAsync({ address: vault, abi: openTreasuryVaultAbi, functionName: "claim", chainId: CHAIN_ID });
    } catch (e) {
      setErr(decodeTxError(e));
      setPhase("error");
      return;
    }
    setPhase("confirming");
    if (!publicClient) return;
    const outcome = await pollReceipt(publicClient, hash);
    if (outcome.status === "lost") return setPhase("lost");
    if (outcome.status === "reverted") {
      setErr("Transaction reverted on-chain.");
      return setPhase("error");
    }
    setPhase("done");
    onDone();
  }

  const busy = phase === "pending" || phase === "confirming";

  return (
    <div className="card border-border p-4">
      <h3 className="text-sm font-semibold text-text-primary">Your rewards</h3>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="figure-primary text-xl">{vault ? fmt(earned, 18) : "0"}</span>
        <span className="metric-secondary">WETH claimable</span>
      </div>
      <div className="mt-2 space-y-1 text-xs text-text-faint">
        <div>Total distributed to date: {totalRewardDeposited !== undefined ? fmt(totalRewardDeposited, 18) : "Unknown"} WETH</div>
        <div>
          {streaming && timeLeft !== undefined
            ? `Current stream: ${formatDuration(timeLeft)} remaining`
            : "No active reward stream right now"}
        </div>
        {rewardsDuration !== undefined && <div>Stream period: {(Number(rewardsDuration) / 86400).toFixed(0)} days</div>}
      </div>
      <button className="btn-primary mt-3 w-full" onClick={claim} disabled={!account || !vault || busy || earned === 0n}>
        {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Claiming…" : "Claim"}
      </button>
      {err && <p className="mt-2 text-xs text-negative">{err}</p>}
      <p className="mt-2 text-[11px] text-text-faint">
        Rewards come only from real trading fees. They are never minted and never paid from principal.
      </p>
    </div>
  );
}

// --------------------------------------------------------------------- //
//  Fund rewards — creator only: claim from hook, then notifyReward       //
// --------------------------------------------------------------------- //

function FundRewardsPanel({ vault, rewardAsset, onDone }: { vault: Address; rewardAsset?: Address; onDone: () => void }) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const f = useAccruedFees(account);
  const [amountStr, setAmountStr] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>();

  const walletWethRes = useReadContract({
    address: rewardAsset,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(rewardAsset && account) },
  });
  const allowanceRes = useReadContract({
    address: rewardAsset,
    abi: erc20Abi,
    functionName: "allowance",
    args: account ? [account, vault] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(rewardAsset && account) },
  });
  const walletWeth = (walletWethRes.data as bigint | undefined) ?? 0n;
  const allowance = (allowanceRes.data as bigint | undefined) ?? 0n;

  let amount = 0n;
  try {
    if (amountStr) amount = parseUnits(amountStr, 18);
  } catch {
    amount = 0n;
  }
  const needsApproval = amount > 0n && allowance < amount;

  async function run(write: () => Promise<`0x${string}`>) {
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
    setAmountStr("");
    onDone();
    void walletWethRes.refetch();
    void allowanceRes.refetch();
  }

  async function approve() {
    if (!rewardAsset) return;
    await run(() => writeContractAsync({ address: rewardAsset, abi: erc20Abi, functionName: "approve", args: [vault, amount], chainId: CHAIN_ID }));
  }
  async function fund() {
    await run(() => writeContractAsync({ address: vault, abi: openTreasuryVaultAbi, functionName: "notifyReward", args: [amount], chainId: CHAIN_ID }));
  }

  const busy = phase === "pending" || phase === "confirming";

  return (
    <div className="card border-accent p-4">
      <h3 className="text-sm font-semibold text-text-primary">Fund rewards (creator)</h3>
      <p className="mt-1 text-xs text-text-faint">
        Claim your WETH swap-fee share from the hook, then stream it to depositors here. Permissionless — anyone could
        fund this, but only you control when and how much.
      </p>

      {f.accruedWeth !== undefined && f.accruedWeth > 0n && f.phase !== "success" && (
        <button className="btn-secondary mt-3 w-full" onClick={f.claim} disabled={f.phase === "claiming"}>
          {f.phase === "claiming" ? "Claiming from hook…" : `Claim ${fmt(f.accruedWeth, 18)} WETH from hook`}
        </button>
      )}

      <label className="mt-3 block">
        <div className="mb-1 flex justify-between text-xs text-text-secondary">
          <span>Amount to fund</span>
          <span>Wallet: {fmt(walletWeth, 18)} WETH</span>
        </div>
        <div className="flex gap-2">
          <input className="input flex-1" inputMode="decimal" placeholder="0.0" value={amountStr} onChange={(e) => setAmountStr(e.target.value)} />
          <button type="button" className="btn-secondary shrink-0 px-3" onClick={() => setAmountStr(formatUnits(walletWeth, 18))}>
            Max
          </button>
        </div>
      </label>

      {needsApproval ? (
        <button className="btn-primary mt-3 w-full" onClick={approve} disabled={busy || amount === 0n}>
          {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Approving…" : "Approve WETH"}
        </button>
      ) : (
        <button className="btn-primary mt-3 w-full" onClick={fund} disabled={busy || amount === 0n || amount > walletWeth}>
          {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Funding…" : "Fund rewards"}
        </button>
      )}
      {err && <p className="mt-2 text-xs text-negative">{err}</p>}
    </div>
  );
}

// --------------------------------------------------------------------- //
//  APR — trailing only, never projected                                 //
// --------------------------------------------------------------------- //

function AprBlock({
  rewardLast7d,
  rewardLast30d,
  communityWithdrawableUsd,
  rewardsDuration,
  status,
}: {
  rewardLast7d?: bigint;
  rewardLast30d?: bigint;
  communityWithdrawableUsd?: bigint;
  rewardsDuration?: bigint;
  status: string;
}) {
  // APR = (rewards actually streamed over the window / annualization factor) /
  // CURRENT deposited USD value — a standard trailing approximation (not a
  // time-weighted-average TVL, which this app doesn't track). "Not enough
  // history" when the scan failed or there's been no stream of at least the
  // window length yet.
  const enoughHistory = status === "ok" || status === "partial";
  const apr7d =
    enoughHistory && rewardLast7d !== undefined && communityWithdrawableUsd && communityWithdrawableUsd > 0n
      ? (Number(rewardLast7d) / 1e18 / (Number(communityWithdrawableUsd) / 1e18)) * (365 / 7) * 100
      : undefined;
  const apr30d =
    enoughHistory && rewardLast30d !== undefined && communityWithdrawableUsd && communityWithdrawableUsd > 0n
      ? (Number(rewardLast30d) / 1e18 / (Number(communityWithdrawableUsd) / 1e18)) * (365 / 30) * 100
      : undefined;

  return (
    <div className="rounded-card border border-border p-3">
      <div className="grid grid-cols-2 gap-3 text-center">
        <div>
          <div className="figure-primary text-lg">{apr7d !== undefined ? `${apr7d.toFixed(1)}%` : "Unknown"}</div>
          <div className="mt-0.5 text-[11px] text-text-faint">Past 7d</div>
        </div>
        <div>
          <div className="figure-primary text-lg">{apr30d !== undefined ? `${apr30d.toFixed(1)}%` : "Unknown"}</div>
          <div className="mt-0.5 text-[11px] text-text-faint">Past 30d</div>
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-text-faint">
        Variable. Based on past fees. Not a promise of future returns.
      </p>
    </div>
  );
}

// --------------------------------------------------------------------- //
//  Contributors                                                         //
// --------------------------------------------------------------------- //

function ContributorList({
  events,
  listedAssets,
  status,
}: {
  events: ReturnType<typeof useOpenTreasuryActivity>["events"];
  listedAssets: AllowedAsset[];
  status: string;
}) {
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;
  const explorer = activeChain.blockExplorers.default.url;
  const pageItems = useMemo(() => events.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [events, page]);

  if (status === "failed") return <p className="text-xs text-text-faint">Contributor list: Unknown (event scan unavailable)</p>;
  if (status === "loading" || status === "idle") return <p className="text-xs text-text-faint">Loading contributors…</p>;
  if (events.length === 0) return <p className="text-xs text-text-faint">No deposits yet.</p>;

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-text-primary">Contributors</h3>
      <div className="space-y-1.5">
        {pageItems.map((e, i) => {
          const dec = listedAssets.find((a) => a.address.toLowerCase() === e.asset.toLowerCase())?.decimals ?? 18;
          const sym = listedAssets.find((a) => a.address.toLowerCase() === e.asset.toLowerCase())?.symbol ?? shortAddress(e.asset);
          return (
            <div key={`${e.txHash}-${i}`} className="flex items-center justify-between gap-2 text-xs">
              <span className={e.kind === "deposit" ? "text-green" : "text-text-faint"}>{e.kind === "deposit" ? "+" : "−"}</span>
              <span className="flex-1 truncate text-text-secondary">{shortAddress(e.depositor)}</span>
              <span className="text-text-faint">
                {fmt(e.amount, dec)} {sym}
              </span>
              <a className="text-text-faint underline hover:text-text-secondary" href={`${explorer}/tx/${e.txHash}`} target="_blank" rel="noreferrer">
                tx
              </a>
            </div>
          );
        })}
      </div>
      {events.length > PAGE_SIZE && (
        <div className="mt-2 flex justify-center gap-2">
          <button className="btn-secondary px-3 py-1 text-xs" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
            Prev
          </button>
          <button
            className="btn-secondary px-3 py-1 text-xs"
            onClick={() => setPage((p) => p + 1)}
            disabled={(page + 1) * PAGE_SIZE >= events.length}
          >
            Next
          </button>
        </div>
      )}
      {status === "partial" && <p className="mt-2 text-[11px] text-text-faint">Partial scan — some older activity may be missing.</p>}
    </div>
  );
}
