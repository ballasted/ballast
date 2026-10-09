"use client";

import { useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import {
  ramsesLockerAbi,
  ramsesLockLauncherAbi,
  ballastFeeSplitterAbi,
  ramsesV3FactoryAbi,
  ramsesV3PoolAbi,
  erc20Abi,
} from "@/lib/abis";
import {
  RAMSES_LOCKER_ADDRESS,
  RAMSES_LAUNCHER_ADDRESS,
  RAMSES_V3_FACTORY_ADDRESS,
  RAMSES_V3_POSITION_MANAGER_ADDRESS,
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

// Nearest tickSpacing-100 multiples to Uniswap's MIN/MAX_TICK -- the far edge
// of a one-sided range (the near edge sits just off the current/initial
// price, computed live below). Ballast creators hold none of their own
// launched token (the full supply went to the gen-4 pool at graduation), so
// this position is ALWAYS single-sided: only the quote asset, never the
// launched token -- same shape as a fresh Ballast launch's own one-sided seed,
// just the other leg.
const MIN_TICK = -887200;
const MAX_TICK = 887200;
const TICK_SPACING = 100;
// Buffer (in tickSpacing units) kept between the current/initial price and the
// position's near edge, so floating-point rounding in the price->tick
// conversion can never land the range on the wrong side of the live price.
const TICK_SAFETY_BUFFER = 2 * TICK_SPACING;
// Default price-deviation tolerance passed to the launcher's pool-init
// protection (RamsesLockLauncher.MAX_PRICE_DEVIATION_BPS ceiling is 2000) --
// covers ordinary price drift between this read and tx inclusion without
// opening the door to a meaningfully mispriced pool.
const DEFAULT_MAX_PRICE_DEVIATION_BPS = 500;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function alignDown(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}
function alignUp(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}
// tick = log_1.0001(price), price = token1/token0.
function tickFromPriceToken1PerToken0(priceToken1PerToken0: number): number {
  return Math.log(priceToken1PerToken0) / Math.log(1.0001);
}

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
        <ExistingPosition token={token} creator={creator} symbol={symbol} pos={pos} />
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
  creator,
  symbol,
  pos,
}: {
  token: Address;
  creator?: Address;
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

  const poolRes = useReadContract({
    address: RAMSES_V3_FACTORY_ADDRESS,
    abi: ramsesV3FactoryAbi,
    functionName: "getPool",
    args: pos.position ? [pos.position.token0, pos.position.token1, RAMSES_TICK_SPACING] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(pos.position) },
  });
  const poolAddress = poolRes.data as Address | undefined;

  const isLaunchedToken0 = pos.position?.token0.toLowerCase() === token.toLowerCase();
  // createAndLock is fully permissionless -- anyone can lock a position for
  // any token and name anyone as creatorRecipient. Never assume the funder
  // IS this token's creator; only say "creator" when it actually matches.
  const fundedByCreator = Boolean(
    creator && pos.position && creator.toLowerCase() === pos.position.creatorRecipient.toLowerCase(),
  );
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
        {fundedByCreator ? "Funded by this token's creator" : "Funded by"}
        {!fundedByCreator && pos.position && (
          <>
            {" "}
            <a
              className="underline hover:text-text-secondary"
              href={`${activeChain.blockExplorers.default.url}/address/${pos.position.creatorRecipient}`}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddress(pos.position.creatorRecipient)}
            </a>
            , not this token&apos;s creator — anyone can lock a Ramses position for any token
          </>
        )}
        .
      </p>

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

      <div className="space-y-1">
        <a
          className="block text-xs text-text-faint underline hover:text-text-secondary"
          href={`${activeChain.blockExplorers.default.url}/token/${RAMSES_V3_POSITION_MANAGER_ADDRESS}/instance/${pos.position?.tokenId}`}
          target="_blank"
          rel="noreferrer"
        >
          View locked position ↗
        </a>
        {poolAddress && poolAddress !== ZERO && (
          <a
            className="block text-xs text-text-faint underline hover:text-text-secondary"
            href={`${activeChain.blockExplorers.default.url}/address/${poolAddress}`}
            target="_blank"
            rel="noreferrer"
          >
            View Ramses pool ↗
          </a>
        )}
      </div>
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
  const [quoteAmountStr, setQuoteAmountStr] = useState("");
  const [initialPriceStr, setInitialPriceStr] = useState(""); // quote per launched token, only if pool doesn't exist yet
  const [confirmed, setConfirmed] = useState(false);
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
  const quoteIsToken0 = !tokenIsToken0;

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

  // Only read when the pool exists -- this is the authoritative live price
  // (RamsesLockLauncher will read the same slot0() itself at tx time and
  // compare against what we pass as expectedSqrtPriceX96, within tolerance).
  const slot0Res = useReadContract({
    address: poolAddress,
    abi: ramsesV3PoolAbi,
    functionName: "slot0",
    chainId: CHAIN_ID,
    query: { enabled: poolExists },
  });
  const liveSqrtPriceX96 = slot0Res.data ? (slot0Res.data[0] as bigint) : undefined;
  const liveTick = slot0Res.data ? (slot0Res.data[1] as number) : undefined;

  const quoteDecimals = quoteAsset?.decimals ?? 18;

  let quoteAmount = 0n;
  try {
    if (quoteAmountStr) quoteAmount = parseUnits(quoteAmountStr, quoteDecimals);
  } catch {
    quoteAmount = 0n;
  }

  const walletQuoteRes = useReadContract({
    address: quoteAsset?.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: Boolean(account && quoteAsset) },
  });
  const walletQuote = (walletQuoteRes.data as bigint | undefined) ?? 0n;

  const needsInitialPrice = !poolExists;
  let initialPriceValid = true;
  if (needsInitialPrice) {
    const p = Number(initialPriceStr);
    initialPriceValid = Number.isFinite(p) && p > 0;
  } else {
    initialPriceValid = liveSqrtPriceX96 !== undefined;
  }
  const amountsValid = quoteAmount > 0n && quoteAmount <= walletQuote;
  const canSubmit =
    amountsValid &&
    initialPriceValid &&
    confirmed &&
    Boolean(RAMSES_LAUNCHER_ADDRESS) &&
    token0 &&
    token1 &&
    quoteAsset;

  const busy = phase === "pending" || phase === "confirming";

  // price (token1/token0) depends on which side is which -- the UI's price
  // input is always "quote asset units per launched token".
  function priceToken1PerToken0(quotePerToken: number): number {
    return tokenIsToken0 ? quotePerToken : 1 / quotePerToken;
  }
  function sqrtPriceX96FromPriceToken1PerToken0(p: number): bigint {
    const Q96 = 2 ** 96;
    return BigInt(Math.round(Math.sqrt(p) * Q96));
  }

  async function submit() {
    if (!publicClient || !token0 || !token1 || !quoteAsset || !RAMSES_LAUNCHER_ADDRESS) return;
    setErr(undefined);
    setPhase("pending");
    try {
      let expectedSqrtPriceX96: bigint;
      let currentTick: number;
      if (poolExists) {
        if (liveSqrtPriceX96 === undefined || liveTick === undefined) {
          setErr("Could not read the pool's live price.");
          setPhase("error");
          return;
        }
        expectedSqrtPriceX96 = liveSqrtPriceX96;
        currentTick = liveTick;
      } else {
        const p1per0 = priceToken1PerToken0(Number(initialPriceStr));
        expectedSqrtPriceX96 = sqrtPriceX96FromPriceToken1PerToken0(p1per0);
        currentTick = tickFromPriceToken1PerToken0(p1per0);
      }

      // Single-sided by construction: creators hold none of their own
      // launched token, so this position is ONLY ever the quote asset. The
      // tick range sits entirely on the correct side of the current/initial
      // price for that to be valid V3 math (the launcher will also enforce
      // the price itself -- see RamsesLockLauncher._ensurePoolPrice).
      //
      // V3 math: a position holds 100% token0 when the CURRENT price is
      // BELOW the whole range (sqrtPriceX96 <= sqrtRatioAtTickLower), and
      // 100% token1 when it's ABOVE the whole range (sqrtPriceX96 >=
      // sqrtRatioAtTickUpper) -- see LiquidityAmounts.getAmountsForLiquidity.
      // So depositing ONLY token0 needs the range entirely ABOVE current
      // price, and ONLY token1 needs it entirely BELOW.
      let tickLower: number;
      let tickUpper: number;
      if (quoteIsToken0) {
        // Quote = token0 -> range entirely ABOVE current price.
        tickLower = alignUp(currentTick, TICK_SPACING) + TICK_SAFETY_BUFFER;
        tickUpper = MAX_TICK;
      } else {
        // Quote = token1 -> range entirely BELOW current price.
        tickUpper = alignDown(currentTick, TICK_SPACING) - TICK_SAFETY_BUFFER;
        tickLower = MIN_TICK;
      }

      const amount0Desired = quoteIsToken0 ? quoteAmount : 0n;
      const amount1Desired = quoteIsToken0 ? 0n : quoteAmount;
      // 1% tolerance on the single nonzero leg -- the amount is fully
      // deterministic given price + range, this only covers price drift
      // between this read and tx inclusion.
      const amount0Min = quoteIsToken0 ? (quoteAmount * 99n) / 100n : 0n;
      const amount1Min = quoteIsToken0 ? 0n : (quoteAmount * 99n) / 100n;

      const quoteApproveHash = await writeContractAsync({
        address: quoteAsset.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [RAMSES_LAUNCHER_ADDRESS, quoteAmount],
        chainId: CHAIN_ID,
      });
      setPhase("confirming");
      await pollReceipt(publicClient, quoteApproveHash);
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
            tickLower,
            tickUpper,
            amount0Desired,
            amount1Desired,
            amount0Min,
            amount1Min,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          },
          token,
          creator,
          8000,
          2000,
          expectedSqrtPriceX96,
          DEFAULT_MAX_PRICE_DEVIATION_BPS,
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
      setQuoteAmountStr("");
      setConfirmed(false);
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
        Back ${symbol || "this token"} with a permanently locked Ramses pool (1% fee tier). You provide only the quote
        asset — this token has no creator allocation to pair against. 80% of fees go to you, 20% to the protocol.
      </p>

      <select
        className="input"
        value={assetIdx}
        onChange={(e) => {
          setAssetIdx(Number(e.target.value));
          setConfirmed(false);
        }}
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
            No pool exists yet — set its starting price ({quoteAsset?.symbol ?? "quote"} per {symbol || "token"}). This
            transaction creates the pool at that price atomically — no one else can set it first.
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
        <p className="text-xs text-text-faint">
          Pool already exists at {poolAddress ? shortAddress(poolAddress) : ""}. This transaction checks its live
          price is within {(DEFAULT_MAX_PRICE_DEVIATION_BPS / 100).toFixed(1)}% of what was just read and refuses to
          lock liquidity if it isn't.
        </p>
      )}

      <label className="flex items-start gap-2 text-sm text-text-secondary">
        <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
        <span>
          This {quoteAsset?.symbol ?? "deposit"} is locked permanently. You keep 80% of the fees it earns; the deposit
          itself can never be withdrawn.
        </span>
      </label>

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
