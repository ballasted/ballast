"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useReadContract, useReadContracts, usePublicClient, useWriteContract } from "wagmi";
import type { Address } from "viem";
import { erc20Abi, quoterAbi, stateViewAbi } from "@/lib/abis";
import { V1_CLAIM_ADDRESS, V1_TOKEN_ADDRESS, BALLAST_V2_TOKEN_ADDRESS, WETH_ADDRESS, QUOTER_ADDRESS, STATE_VIEW_ADDRESS, isV1ClaimConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { liveQuery } from "@/lib/refresh";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";
import { candidatePoolKeys, poolKeyForToken, poolId, buyZeroForOne, tokenIsCurrency0, tokenPriceInQuote } from "@/lib/pool";
import { computeMinOut, swapDeadline } from "@/lib/swap";

const CHAIN_ID = activeChain.id;

export const ballastV1ClaimAbi = [
  { type: "function", name: "merkleRoot", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "deadline", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "burnedOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "pathOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "claimETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountV1", type: "uint256" },
      { name: "snapshotBalance", type: "uint256" },
      { name: "ethAmount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
    ],
    outputs: [{ name: "ethPaid", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountV1", type: "uint256" },
      { name: "snapshotBalance", type: "uint256" },
      { name: "ethAmount", type: "uint256" },
      { name: "proof", type: "bytes32[]" },
      { name: "minOut", type: "uint256" },
      { name: "swapDeadline", type: "uint256" },
    ],
    outputs: [{ name: "tokensOut", type: "uint256" }],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "v1Burned", type: "uint256", indexed: false },
      { name: "ethPaid", type: "uint256", indexed: false },
      { name: "cumulativeBurned", type: "uint256", indexed: false },
      { name: "snapshotBalance", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ClaimedToken",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "v1Burned", type: "uint256", indexed: false },
      { name: "ethSwapped", type: "uint256", indexed: false },
      { name: "tokensOut", type: "uint256", indexed: false },
      { name: "cumulativeBurned", type: "uint256", indexed: false },
      { name: "snapshotBalance", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "DeadlineNotYetPassed", inputs: [] },
  { type: "error", name: "DeadlinePassed", inputs: [] },
  { type: "error", name: "SwapDeadlineExpired", inputs: [] },
  { type: "error", name: "AlreadyFullyClaimed", inputs: [] },
  { type: "error", name: "NothingToClaim", inputs: [] },
  { type: "error", name: "InvalidProof", inputs: [] },
  { type: "error", name: "WrongPath", inputs: [] },
  { type: "error", name: "MinOutTooLow", inputs: [] },
  { type: "error", name: "InsufficientOutput", inputs: [] },
  { type: "error", name: "EthTransferFailed", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const;

type ClaimEntry = {
  balanceWei: string;
  ethAmountWei: string;
  usdValue: string;
  leaf: `0x${string}`;
  proof: `0x${string}`[];
};
type ClaimData = { root: `0x${string}`; holders: number; claims: Record<string, ClaimEntry> };

let cachedClaimData: ClaimData | null = null;
async function loadClaimData(): Promise<ClaimData> {
  if (cachedClaimData) return cachedClaimData;
  const res = await fetch("/data/v1-claim-merkle.json");
  if (!res.ok) throw new Error("Could not load the claim list");
  cachedClaimData = (await res.json()) as ClaimData;
  return cachedClaimData;
}

export type ClaimPhase = "idle" | "approving" | "claiming" | "success" | "error";
export type ClaimPathChoice = "eth" | "token";
// Mirrors BallastV1Claim.sol's ClaimPath enum (0 = None, 1 = Eth, 2 = Token).
export type OnchainClaimPath = 0 | 1 | 2;

export type MigrationStats = {
  isLoading: boolean;
  error: boolean;
  claimCount: number;
  uniqueClaimers: number;
  totalEthPaid: bigint;
  totalV1Burned: bigint;
};

/** Global migration progress, swept from `Claimed`+`ClaimedToken` events —
 *  the same getContractEvents pattern useBuyback's history uses. Independent
 *  of any connected wallet. "ETH paid" counts the ETH VALUE of a token claim
 *  too (`ethSwapped`), so the total tracks against the fixed budget regardless
 *  of which path each holder chose. */
export function useMigrationStats(): MigrationStats {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [stats, setStats] = useState<MigrationStats>({
    isLoading: true,
    error: false,
    claimCount: 0,
    uniqueClaimers: 0,
    totalEthPaid: 0n,
    totalV1Burned: 0n,
  });

  useEffect(() => {
    if (!publicClient || !V1_CLAIM_ADDRESS) {
      setStats((s) => ({ ...s, isLoading: false }));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [ethLogs, tokenLogs] = await Promise.all([
          publicClient.getContractEvents({
            address: V1_CLAIM_ADDRESS,
            abi: ballastV1ClaimAbi,
            eventName: "Claimed",
            fromBlock: "earliest",
            toBlock: "latest",
          }),
          publicClient.getContractEvents({
            address: V1_CLAIM_ADDRESS,
            abi: ballastV1ClaimAbi,
            eventName: "ClaimedToken",
            fromBlock: "earliest",
            toBlock: "latest",
          }),
        ]);
        if (cancelled) return;
        const claimers = new Set<string>();
        let ethPaid = 0n;
        let v1Burned = 0n;
        for (const l of ethLogs) {
          const a = l.args as { account?: Address; v1Burned?: bigint; ethPaid?: bigint };
          if (a.account) claimers.add(a.account.toLowerCase());
          ethPaid += a.ethPaid ?? 0n;
          v1Burned += a.v1Burned ?? 0n;
        }
        for (const l of tokenLogs) {
          const a = l.args as { account?: Address; v1Burned?: bigint; ethSwapped?: bigint };
          if (a.account) claimers.add(a.account.toLowerCase());
          ethPaid += a.ethSwapped ?? 0n;
          v1Burned += a.v1Burned ?? 0n;
        }
        setStats({
          isLoading: false,
          error: false,
          claimCount: ethLogs.length + tokenLogs.length,
          uniqueClaimers: claimers.size,
          totalEthPaid: ethPaid,
          totalV1Burned: v1Burned,
        });
      } catch {
        if (!cancelled) setStats((s) => ({ ...s, isLoading: false, error: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  return stats;
}

export type BallastV2Quote = {
  isLoading: boolean;
  error: boolean;
  tokensOut?: bigint;
  priceImpactPct?: number;
};

/** Live quote for swapping `ethAmountWei` into $BALLAST v2 through its real
 *  WETH pool — the same V4Quoter + StateView pattern useSwap uses for trading,
 *  just read-only (the actual swap happens inside BallastV1Claim.claimToken
 *  itself, never from the frontend's own wallet). Resolves which hook the
 *  pool actually lives under the same way useSwap does (probe liquidity
 *  across every hook generation), since a hook redeploy stops a prior pool
 *  resolving under the current one — see lib/contracts.ts's HOOK_ADDRESSES. */
export function useBallastV2TokenQuote(ethAmountWei: bigint | undefined): BallastV2Quote {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const [state, setState] = useState<BallastV2Quote>({ isLoading: false, error: false });

  const candidates = useMemo(
    () => (BALLAST_V2_TOKEN_ADDRESS && WETH_ADDRESS ? candidatePoolKeys(BALLAST_V2_TOKEN_ADDRESS, WETH_ADDRESS) : []),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const stateView = STATE_VIEW_ADDRESS;
    const quoter = QUOTER_ADDRESS;
    const weth = WETH_ADDRESS;
    if (!publicClient || !quoter || !stateView || !weth || !ethAmountWei || ethAmountWei <= 0n || candidates.length === 0) {
      setState({ isLoading: false, error: false });
      return;
    }
    const amountIn = ethAmountWei;
    setState((s) => ({ ...s, isLoading: true, error: false }));
    (async () => {
      try {
        // Resolve the live hook: probe liquidity across every known hook
        // generation and use whichever one actually has a seeded pool.
        const liqs = await Promise.all(
          candidates.map((c) =>
            publicClient
              .readContract({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [c.id] })
              .catch(() => 0n),
          ),
        );
        const first = candidates[0];
        if (!first) throw new Error("no candidate pool");
        const live = candidates.find((_, i) => (liqs[i] as bigint) > 0n) ?? first;
        const key = poolKeyForToken(BALLAST_V2_TOKEN_ADDRESS, weth, live.hook);
        if (!key) throw new Error("no pool key");

        const [slot0, quoteRes] = await Promise.all([
          publicClient.readContract({
            address: stateView,
            abi: stateViewAbi,
            functionName: "getSlot0",
            args: [poolId(key)],
          }),
          publicClient.simulateContract({
            address: quoter,
            abi: quoterAbi,
            functionName: "quoteExactInputSingle",
            args: [
              {
                poolKey: key,
                zeroForOne: buyZeroForOne(BALLAST_V2_TOKEN_ADDRESS, weth),
                exactAmount: amountIn,
                hookData: "0x",
              },
            ],
          }),
        ]);
        if (cancelled) return;

        const tokensOut = (quoteRes.result as readonly [bigint, bigint])[0];
        const sqrtPriceX96 = (slot0 as readonly [bigint, number, number, number])[0];
        const ballastIsCurrency0 = tokenIsCurrency0(BALLAST_V2_TOKEN_ADDRESS, weth);
        // WETH per $BALLAST v2, 1e18 — pool mid, same shape SwapPanel's
        // spotPriceWeth uses for its own price-impact calc.
        const spotPriceWeth = tokenPriceInQuote(sqrtPriceX96, ballastIsCurrency0, 18);

        let priceImpactPct: number | undefined;
        if (spotPriceWeth > 0n && tokensOut > 0n) {
          const spot = Number(spotPriceWeth) / 1e18;
          priceImpactPct = (Number(amountIn) / Number(tokensOut) / spot - 1) * 100;
        }

        setState({ isLoading: false, error: false, tokensOut, priceImpactPct });
      } catch {
        if (!cancelled) setState({ isLoading: false, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, ethAmountWei, candidates]);

  return state;
}

export function useV1Claim(account?: Address) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const [entry, setEntry] = useState<ClaimEntry | undefined>(undefined);
  const [holders, setHolders] = useState<number | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [phase, setPhase] = useState<ClaimPhase>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    loadClaimData()
      .then((d) => {
        if (cancelled) return;
        setHolders(d.holders);
        setEntry(account ? d.claims[account.toLowerCase()] : undefined);
      })
      .catch(() => !cancelled && setLoadError(true));
    return () => {
      cancelled = true;
    };
  }, [account]);

  const snapshotBalance = entry ? BigInt(entry.balanceWei) : undefined;
  const ethAmount = entry ? BigInt(entry.ethAmountWei) : undefined;

  const stateRes = useReadContracts({
    allowFailure: true,
    contracts:
      V1_CLAIM_ADDRESS && account
        ? ([
            { address: V1_CLAIM_ADDRESS, abi: ballastV1ClaimAbi, functionName: "burnedOf", args: [account], chainId: CHAIN_ID },
            { address: V1_CLAIM_ADDRESS, abi: ballastV1ClaimAbi, functionName: "deadline", chainId: CHAIN_ID },
            { address: V1_CLAIM_ADDRESS, abi: ballastV1ClaimAbi, functionName: "pathOf", args: [account], chainId: CHAIN_ID },
            { address: V1_TOKEN_ADDRESS, abi: erc20Abi, functionName: "balanceOf", args: [account], chainId: CHAIN_ID },
            {
              address: V1_TOKEN_ADDRESS,
              abi: erc20Abi,
              functionName: "allowance",
              args: [account, V1_CLAIM_ADDRESS],
              chainId: CHAIN_ID,
            },
          ] as const)
        : [],
    query: liveQuery(isV1ClaimConfigured && Boolean(account)),
  });

  const pick = (i: number) => (stateRes.data?.[i]?.status === "success" ? stateRes.data[i].result : undefined);
  const burned = pick(0) as bigint | undefined;
  const deadline = pick(1) as bigint | undefined;
  const lockedPath = pick(2) as OnchainClaimPath | undefined;
  const v1Balance = pick(3) as bigint | undefined;
  const allowance = pick(4) as bigint | undefined;

  const remaining = snapshotBalance !== undefined && burned !== undefined ? snapshotBalance - burned : undefined;
  const claimedEth =
    ethAmount !== undefined && snapshotBalance !== undefined && snapshotBalance > 0n && burned !== undefined
      ? (ethAmount * burned) / snapshotBalance
      : undefined;
  const fullyClaimed = remaining !== undefined && remaining <= 0n;
  const deadlinePassed = deadline !== undefined && deadline > 0n && BigInt(Math.floor(Date.now() / 1000)) >= deadline;
  // undefined until the on-chain read lands; 0 = not locked to anything yet.
  const lockedTo: ClaimPathChoice | undefined =
    lockedPath === 1 ? "eth" : lockedPath === 2 ? "token" : lockedPath === 0 ? undefined : undefined;

  const ensureApproval = useCallback(
    async (amountV1: bigint) => {
      if (!publicClient || !account || !V1_CLAIM_ADDRESS) return;
      if (allowance === undefined || allowance < amountV1) {
        setPhase("approving");
        const approveHash = await writeContractAsync({
          address: V1_TOKEN_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [V1_CLAIM_ADDRESS, amountV1],
          chainId: CHAIN_ID,
        });
        const outcome = await pollReceipt(publicClient, approveHash);
        if (outcome.status !== "success") throw new Error("Approval did not confirm");
      }
    },
    [publicClient, account, allowance, writeContractAsync],
  );

  const claim = useCallback(
    async (amountV1: bigint) => {
      if (!publicClient || !account || !entry || !V1_CLAIM_ADDRESS) return;
      setError(undefined);
      setTxHash(undefined);
      try {
        await ensureApproval(amountV1);
        setPhase("claiming");
        const hash = await writeContractAsync({
          address: V1_CLAIM_ADDRESS,
          abi: ballastV1ClaimAbi,
          functionName: "claimETH",
          args: [amountV1, BigInt(entry.balanceWei), BigInt(entry.ethAmountWei), entry.proof],
          chainId: CHAIN_ID,
        });
        setTxHash(hash);
        const outcome = await pollReceipt(publicClient, hash);
        if (outcome.status === "lost") throw new Error(`We lost track of the claim — check Blockscout: ${hash}`);
        if (outcome.status === "reverted") throw new Error(`The claim reverted — check Blockscout: ${hash}`);
        setPhase("success");
        void stateRes.refetch();
      } catch (e) {
        setError(decodeTxError(e));
        setPhase("error");
      }
    },
    [publicClient, account, entry, writeContractAsync, stateRes, ensureApproval],
  );

  /** `minOut` must already be sourced from a live quote + the chosen slippage
   *  (useBallastV2TokenQuote + computeMinOut) — the contract itself rejects a
   *  zero floor, but a 1-wei floor would still pass its check while giving up
   *  every real protection, so the caller is responsible for a genuine quote. */
  const claimAsToken = useCallback(
    async (amountV1: bigint, minOut: bigint) => {
      if (!publicClient || !account || !entry || !V1_CLAIM_ADDRESS) return;
      setError(undefined);
      setTxHash(undefined);
      try {
        await ensureApproval(amountV1);
        setPhase("claiming");
        const nowSec = Math.floor(Date.now() / 1000);
        const hash = await writeContractAsync({
          address: V1_CLAIM_ADDRESS,
          abi: ballastV1ClaimAbi,
          functionName: "claimToken",
          args: [amountV1, BigInt(entry.balanceWei), BigInt(entry.ethAmountWei), entry.proof, minOut, swapDeadline(nowSec)],
          chainId: CHAIN_ID,
        });
        setTxHash(hash);
        const outcome = await pollReceipt(publicClient, hash);
        if (outcome.status === "lost") throw new Error(`We lost track of the claim — check Blockscout: ${hash}`);
        if (outcome.status === "reverted") throw new Error(`The claim reverted — check Blockscout: ${hash}`);
        setPhase("success");
        void stateRes.refetch();
      } catch (e) {
        setError(decodeTxError(e));
        setPhase("error");
      }
    },
    [publicClient, account, entry, writeContractAsync, stateRes, ensureApproval],
  );

  return {
    configured: isV1ClaimConfigured,
    isInSnapshot: Boolean(entry),
    holders,
    loadError,
    snapshotBalance,
    ethAmount,
    burned,
    remaining,
    claimedEth,
    fullyClaimed,
    deadline,
    deadlinePassed,
    lockedTo,
    v1Balance,
    phase,
    txHash,
    error,
    claim,
    claimAsToken,
    reset: () => {
      setPhase("idle");
      setError(undefined);
      setTxHash(undefined);
    },
  };
}

export { computeMinOut };
