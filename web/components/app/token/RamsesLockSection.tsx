"use client";

import { useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import {
  ramsesLockerAbi,
  ramsesLockLauncherAbi,
  ballastFeeSplitterAbi,
  ramsesV3FactoryAbi,
  erc20Abi,
} from "@/lib/abis";
import {
  RAMSES_LOCKER_ADDRESS,
  RAMSES_LAUNCHER_ADDRESS,
  RAMSES_V3_FACTORY_ADDRESS,
  RAMSES_TICK_SPACING,
  DEAD_ADDRESS,
  isRamsesEnabled,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { pollReceipt } from "@/lib/waitForReceipt";
import { decodeTxError } from "@/lib/txError";
import { useNetworkGuard } from "@/hooks/useNetworkGuard";
import { useAssets, type AllowedAsset } from "@/hooks/useAssets";
import { useRamsesPosition } from "@/hooks/useRamsesPosition";
import { shortAddress } from "@/lib/format";
import { cn } from "@/lib/cn";

const CHAIN_ID = activeChain.id;
type Phase = "idle" | "pending" | "confirming" | "lost" | "error" | "done";

// Full-range (nearest tickSpacing-100 multiples to Uniswap's MIN/MAX_TICK) --
// valid regardless of current price, so this never needs a live tick read to
// pick a range. Deliberately not single-sided (that shape is for a fresh
// launch's own one-sided seed, not an opt-in liquidity contribution here).
const FULL_RANGE_LOWER = -887200;
const FULL_RANGE_UPPER = 887200;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function fmt(v: bigint | undefined, decimals: number, maxFractionDigits = 6): string {
  if (v === undefined) return "Unknown";
  return Number(formatUnits(v, decimals)).toLocaleString("en", { maximumFractionDigits: maxFractionDigits });
}

/**
 * Ramses locked-pool section — an OPTIONAL, creator-initiated liquidity
 * contribution on Ramses' real Concentrated Liquidity venue, separate from
 * this token's gen-4 Uniswap v4 pool. Entirely behind NEXT_PUBLIC_RAMSES_ENABLED
 * (default off) — renders nothing when disabled/unconfigured.
 */
export function RamsesLockSection({ token, creator, symbol }: { token?: Address; creator?: Address; symbol?: string }) {
  const { address: account } = useAccount();
  const pos = useRamsesPosition(token);
  const isCreator = Boolean(account && creator && account.toLowerCase() === creator.toLowerCase());

  if (!pos.enabled || !token) return null;

  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="section-label">Ramses locked pool</h2>
        <p className="mt-1 text-xs text-text-faint">
          Ramses governance sets the protocol fee on its pools (currently 5% of fees). The locked position receives the
          rest.
        </p>
      </div>

      {pos.status === "loading" && <p className="text-xs text-text-faint">Checking for a locked position…</p>}
      {pos.status === "failed" && <p className="text-xs text-text-faint">Unknown (event scan unavailable)</p>}

      {pos.position ? (
        <ExistingPosition token={token} symbol={symbol} pos={pos} />
      ) : (
        pos.status === "ok" &&
        (isCreator ? (
          <SetupPanel token={token} creator={creator!} symbol={symbol} onDone={pos.refetch} />
        ) : (
          <p className="text-xs text-text-muted">No Ramses-locked position for this token yet.</p>
        ))
      )}

      <p className="rounded-input bg-bg px-3 py-2 text-xs text-text-muted">
        Holding ${symbol || "TICKER"} gives no claim, redemption right, or entitlement to these assets.
      </p>
    </section>
  );
}

function ExistingPosition({
  token,
  symbol,
  pos,
}: {
  token: Address;
  symbol?: string;
  pos: ReturnType<typeof useRamsesPosition>;
}) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>();

  const token0SymRes = useReadContract({
    address: pos.position?.token0,
    abi: erc20Abi,
    functionName: "symbol",
    chainId: CHAIN_ID,
    query: { enabled: Boolean(pos.position) },
  });
  const token1SymRes = useReadContract({
    address: pos.position?.token1,
    abi: erc20Abi,
    functionName: "symbol",
    chainId: CHAIN_ID,
    query: { enabled: Boolean(pos.position) },
  });
  const sym0 = (token0SymRes.data as string | undefined) ?? shortAddress(pos.position?.token0 ?? ZERO);
  const sym1 = (token1SymRes.data as string | undefined) ?? shortAddress(pos.position?.token1 ?? ZERO);

  const isLaunchedToken0 = pos.position?.token0.toLowerCase() === token.toLowerCase();
  const protocolShareBurned = pos.protocolRecipient
    ? // The sink burns anything that isn't WETH/AssetRegistry-listed -- the
      // launched token side of this pool always qualifies, shown plainly
      // rather than guessed per-token here (the sink itself decides on-chain).
      true
    : undefined;

  const busy = phase === "pending" || phase === "confirming";

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
    pos.refetch();
    void token0SymRes.refetch();
    void token1SymRes.refetch();
  }

  async function collect() {
    if (!pos.position) return;
    await run(() =>
      writeContractAsync({
        address: RAMSES_LOCKER_ADDRESS!,
        abi: ramsesLockerAbi,
        functionName: "collect",
        args: [pos.position!.tokenId],
        chainId: CHAIN_ID,
      }),
    );
  }

  async function distribute() {
    if (!pos.position) return;
    await run(() =>
      writeContractAsync({
        address: pos.position!.splitter,
        abi: ballastFeeSplitterAbi,
        functionName: "distribute",
        args: [pos.position!.token0],
        chainId: CHAIN_ID,
      }),
    );
    await run(() =>
      writeContractAsync({
        address: pos.position!.splitter,
        abi: ballastFeeSplitterAbi,
        functionName: "distribute",
        args: [pos.position!.token1],
        chainId: CHAIN_ID,
      }),
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 rounded-card border border-border p-3 text-center">
        <div>
          <div className="figure-primary text-base">{fmt(pos.pendingFees0, 18)}</div>
          <div className="mt-0.5 text-[11px] text-text-faint">Pending fees — {sym0}</div>
        </div>
        <div>
          <div className="figure-primary text-base">{fmt(pos.pendingFees1, 18)}</div>
          <div className="mt-0.5 text-[11px] text-text-faint">Pending fees — {sym1}</div>
        </div>
      </div>

      <p className="text-xs text-text-faint">
        The protocol&apos;s share of fees paid in {isLaunchedToken0 ? sym0 : sym1} is sent to the dead address.
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        <button className="btn-secondary" onClick={collect} disabled={busy}>
          {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Collecting…" : "Collect fees"}
        </button>
        <button className="btn-secondary" onClick={distribute} disabled={busy}>
          {busy ? "Working…" : "Distribute"}
        </button>
      </div>
      {phase === "lost" && <p className="text-xs text-warning">Lost track of this transaction — check Blockscout before retrying.</p>}
      {err && <p className="text-xs text-negative">{err}</p>}

      <a
        className="block text-xs text-text-faint underline hover:text-text-secondary"
        href={`${activeChain.blockExplorers.default.url}/token/${RAMSES_LOCKER_ADDRESS}?a=${pos.position?.tokenId}`}
        target="_blank"
        rel="noreferrer"
      >
        View locked position ↗
      </a>
    </div>
  );
}

function SetupPanel({
  token,
  creator,
  symbol,
  onDone,
}: {
  token: Address;
  creator: Address;
  symbol?: string;
  onDone: () => void;
}) {
  const { address: account } = useAccount();
  const { wrongNetwork, switchToRobinhood, isSwitching } = useNetworkGuard();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { assets: listedAssets } = useAssets();

  const [assetIdx, setAssetIdx] = useState(0);
  const [tokenAmountStr, setTokenAmountStr] = useState("");
  const [quoteAmountStr, setQuoteAmountStr] = useState("");
  const [initialPriceStr, setInitialPriceStr] = useState(""); // quote per launched token, only if pool doesn't exist yet
  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState<string>();

  const quoteAsset = listedAssets[assetIdx] as AllowedAsset | undefined;

  const [token0, token1] =
    quoteAsset && token.toLowerCase() < quoteAsset.address.toLowerCase()
      ? [token, quoteAsset.address]
      : quoteAsset
        ? [quoteAsset.address, token]
        : [undefined, undefined];
  const tokenIsToken0 = token0?.toLowerCase() === token.toLowerCase();

  const poolRes = useReadContract({
    address: RAMSES_V3_FACTORY_ADDRESS,
    abi: ramsesV3FactoryAbi,
    functionName: "getPool",
    args: token0 && token1 ? [token0, token1, RAMSES_TICK_SPACING] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(token0 && token1) },
  });
  const poolAddress = poolRes.data as Address | undefined;
  const poolExists = Boolean(poolAddress && poolAddress !== ZERO);

  const tokenDecimals = 18; // Ballast-launched tokens are always 18 decimals (ERC-8056)
  const quoteDecimals = quoteAsset?.decimals ?? 18;

  let tokenAmount = 0n;
  let quoteAmount = 0n;
  try {
    if (tokenAmountStr) tokenAmount = parseUnits(tokenAmountStr, tokenDecimals);
  } catch {
    tokenAmount = 0n;
  }
  try {
    if (quoteAmountStr) quoteAmount = parseUnits(quoteAmountStr, quoteDecimals);
  } catch {
    quoteAmount = 0n;
  }

  const walletTokenRes = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(account) },
  });
  const walletQuoteRes = useReadContract({
    address: quoteAsset?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(account && quoteAsset) },
  });
  const walletToken = (walletTokenRes.data as bigint | undefined) ?? 0n;
  const walletQuote = (walletQuoteRes.data as bigint | undefined) ?? 0n;

  const amountsValid = tokenAmount > 0n && quoteAmount > 0n && tokenAmount <= walletToken && quoteAmount <= walletQuote;
  const needsInitialPrice = !poolExists;
  let initialPriceValid = true;
  if (needsInitialPrice) {
    const p = Number(initialPriceStr);
    initialPriceValid = Number.isFinite(p) && p > 0;
  }
  const canSubmit = amountsValid && initialPriceValid && Boolean(RAMSES_LAUNCHER_ADDRESS) && token0 && token1;

  const busy = phase === "pending" || phase === "confirming";

  function sqrtPriceX96ForQuotePerToken(quotePerToken: number): bigint {
    // price (token1/token0) depends on which side is which -- quotePerToken is
    // always "quote asset units per launched token", so convert to the
    // token1/token0 ratio before taking the sqrt.
    const priceToken1PerToken0 = tokenIsToken0 ? quotePerToken : 1 / quotePerToken;
    const sqrtPrice = Math.sqrt(priceToken1PerToken0);
    // Q64.96 fixed point.
    const Q96 = 2 ** 96;
    return BigInt(Math.round(sqrtPrice * Q96));
  }

  async function submit() {
    if (!publicClient || !token0 || !token1 || !quoteAsset || !RAMSES_LAUNCHER_ADDRESS) return;
    setErr(undefined);
    setPhase("pending");
    try {
      let pool = poolAddress;
      if (!poolExists) {
        const sqrtPriceX96 = sqrtPriceX96ForQuotePerToken(Number(initialPriceStr));
        const createHash = await writeContractAsync({
          address: RAMSES_V3_FACTORY_ADDRESS!,
          abi: ramsesV3FactoryAbi,
          functionName: "createPool",
          args: [token0, token1, RAMSES_TICK_SPACING, sqrtPriceX96],
          chainId: CHAIN_ID,
        });
        setPhase("confirming");
        const createOutcome = await pollReceipt(publicClient, createHash);
        if (createOutcome.status !== "success") {
          setErr(createOutcome.status === "lost" ? undefined : "Pool creation reverted on-chain.");
          setPhase(createOutcome.status === "lost" ? "lost" : "error");
          return;
        }
        setPhase("pending");
        const refetched = await poolRes.refetch();
        pool = refetched.data as Address | undefined;
      }
      if (!pool || pool === ZERO) {
        setErr("Could not resolve the pool address after creation.");
        setPhase("error");
        return;
      }

      const amount0Desired = tokenIsToken0 ? tokenAmount : quoteAmount;
      const amount1Desired = tokenIsToken0 ? quoteAmount : tokenAmount;

      const approve0Hash = await writeContractAsync({
        address: token0,
        abi: erc20Abi,
        functionName: "approve",
        args: [RAMSES_LAUNCHER_ADDRESS, amount0Desired],
        chainId: CHAIN_ID,
      });
      setPhase("confirming");
      await pollReceipt(publicClient, approve0Hash);
      setPhase("pending");

      const approve1Hash = await writeContractAsync({
        address: token1,
        abi: erc20Abi,
        functionName: "approve",
        args: [RAMSES_LAUNCHER_ADDRESS, amount1Desired],
        chainId: CHAIN_ID,
      });
      setPhase("confirming");
      await pollReceipt(publicClient, approve1Hash);
      setPhase("pending");

      const lockHash = await writeContractAsync({
        address: RAMSES_LAUNCHER_ADDRESS,
        abi: ramsesLockLauncherAbi,
        functionName: "createAndLock",
        args: [
          {
            token0,
            token1,
            tickSpacing: RAMSES_TICK_SPACING,
            tickLower: FULL_RANGE_LOWER,
            tickUpper: FULL_RANGE_UPPER,
            amount0Desired,
            amount1Desired,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          },
          token,
          creator,
          8000,
          2000,
        ],
        chainId: CHAIN_ID,
      });
      setPhase("confirming");
      const outcome = await pollReceipt(publicClient, lockHash);
      if (outcome.status === "lost") return setPhase("lost");
      if (outcome.status === "reverted") {
        setErr("Transaction reverted on-chain.");
        return setPhase("error");
      }
      setPhase("done");
      setTokenAmountStr("");
      setQuoteAmountStr("");
      onDone();
    } catch (e) {
      setErr(decodeTxError(e));
      setPhase("error");
    }
  }

  if (listedAssets.length === 0) {
    return <div className="text-xs text-text-muted">No listed assets available to pair with yet.</div>;
  }

  if (phase === "done") {
    return (
      <div className="note note-positive p-4">
        <div className="font-semibold text-green">Locked ✓</div>
        <button className="btn-secondary mt-3 w-full" onClick={() => setPhase("idle")}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-faint">
        Back ${symbol || "this token"} with a permanently locked Ramses pool (1% fee tier). You provide both legs; 80%
        of fees go to you, 20% to the protocol.
      </p>

      <select
        className="input"
        value={assetIdx}
        onChange={(e) => setAssetIdx(Number(e.target.value))}
        disabled={busy}
      >
        {listedAssets.map((a, i) => (
          <option key={a.address} value={i}>
            Pair with {a.symbol ?? shortAddress(a.address)}
          </option>
        ))}
      </select>

      <label className="block">
        <div className="mb-1 flex justify-between text-xs text-text-secondary">
          <span>{symbol || "Token"} amount</span>
          <span>Wallet: {fmt(walletToken, tokenDecimals)}</span>
        </div>
        <input
          className="input w-full"
          inputMode="decimal"
          placeholder="0.0"
          value={tokenAmountStr}
          onChange={(e) => setTokenAmountStr(e.target.value)}
          disabled={busy}
        />
      </label>

      <label className="block">
        <div className="mb-1 flex justify-between text-xs text-text-secondary">
          <span>{quoteAsset?.symbol ?? "Quote asset"} amount</span>
          <span>Wallet: {fmt(walletQuote, quoteDecimals)}</span>
        </div>
        <input
          className="input w-full"
          inputMode="decimal"
          placeholder="0.0"
          value={quoteAmountStr}
          onChange={(e) => setQuoteAmountStr(e.target.value)}
          disabled={busy}
        />
      </label>

      {needsInitialPrice ? (
        <label className="block">
          <div className="mb-1 text-xs text-text-secondary">
            No pool exists yet — set its starting price ({quoteAsset?.symbol ?? "quote"} per {symbol || "token"})
          </div>
          <input
            className="input w-full"
            inputMode="decimal"
            placeholder="0.0"
            value={initialPriceStr}
            onChange={(e) => setInitialPriceStr(e.target.value)}
            disabled={busy}
          />
        </label>
      ) : (
        <p className="text-xs text-text-faint">Pool already exists at {poolAddress ? shortAddress(poolAddress) : ""}.</p>
      )}

      {!account ? (
        <p className="text-xs text-text-muted">Connect a wallet to continue.</p>
      ) : wrongNetwork ? (
        <button className="btn-primary w-full" onClick={() => void switchToRobinhood()} disabled={isSwitching}>
          {isSwitching ? "Switching…" : "Switch to Robinhood Chain"}
        </button>
      ) : (
        <button className={cn("btn-primary w-full")} onClick={submit} disabled={busy || !canSubmit}>
          {phase === "pending" ? "Confirm in your wallet…" : phase === "confirming" ? "Working…" : "Lock liquidity"}
        </button>
      )}
      {phase === "lost" && <p className="text-xs text-warning">Lost track of this transaction — check Blockscout before retrying.</p>}
      {err && <p className="text-xs text-negative">{err}</p>}
    </div>
  );
}
