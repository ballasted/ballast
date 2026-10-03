"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseUnits, type Address } from "viem";
import { erc20Abi, quoterAbi, quoterMultiHopAbi, ramsesQuoterAbi, ballastRouterV2Abi } from "@/lib/abis";
import { ROUTER_V2_ADDRESS, QUOTER_ADDRESS, RAMSES_QUOTER_ADDRESS, isRouterV2Configured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { poolKeyForToken, buyZeroForOne, sellZeroForOne } from "@/lib/pool";
import {
  routerV2RoutesFor,
  fablesHopsForIdx,
  ramsesRoutesForIdx,
  buildFablesPathKeys,
  reverseIdx,
  NATIVE_ETH_SENTINEL,
  WETH_TOKEN,
} from "@/lib/routerV2";
import { computeMinOut } from "@/lib/swap";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt, replayForRevert } from "@/lib/waitForReceipt";
import { useInvalidateChainReads } from "@/hooks/useInvalidateChainReads";

const CHAIN_ID = activeChain.id;
const MAX_UINT256 = 2n ** 256n - 1n;

export type RouterV2Phase = "idle" | "quoting" | "approving" | "swapping" | "success" | "error";
export type Venue = "fables" | "ramses";

/**
 * Pay-with-ETH-via-router swap for a non-WETH-quoted pool (NVDA/SPY/SGOV/...).
 * Quotes BOTH venues at the user's ACTUAL trade size on every change (never a
 * cached per-ticker preference, never "Fables first" by default — Fables beat
 * Ramses on most tickers in phase-1 research but NVDA itself was ~0.9% better
 * on Ramses, so the only correct rule is "whichever quotes better right now,
 * for this size"), then executes through BallastRouterV2 with the loser wired
 * in as the on-chain fallback.
 */
export function useRouterV2Swap(
  token: Address | undefined,
  side: "buy" | "sell",
  amountStr: string,
  slippageBps: number,
  quoteAsset: Address | undefined,
  hook: Address | undefined,
) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const invalidateChainReads = useInvalidateChainReads();

  const [phase, setPhase] = useState<RouterV2Phase>("idle");
  const [quote, setQuote] = useState<bigint | undefined>();
  const [venue, setVenue] = useState<Venue | undefined>();
  const [quoteError, setQuoteError] = useState<string | undefined>();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  // ETH (buy) and every Ballast token (sell) are both 18-decimal by
  // construction — no decimals() read needed, unlike the direct-quote-asset
  // flow (lib/swap.ts), which must handle an arbitrary ERC-20 input.
  let amountIn = 0n;
  try {
    amountIn = amountStr ? parseUnits(amountStr, 18) : 0n;
  } catch {
    amountIn = 0n;
  }

  const routes = useMemo(() => (quoteAsset ? routerV2RoutesFor(quoteAsset) : undefined), [quoteAsset]);
  const hasFables = Boolean(routes?.fablesHopIdx.length);
  const hasRamses = Boolean(routes?.ramsesHopIdx.length);

  useEffect(() => {
    let cancelled = false;
    setQuote(undefined);
    setVenue(undefined);
    setQuoteError(undefined);
    if (
      !publicClient || !token || !quoteAsset || !hook || !routes || amountIn === 0n ||
      !QUOTER_ADDRESS || (!hasFables && !hasRamses)
    ) {
      return;
    }
    setPhase("quoting");

    (async () => {
      try {
        // Leg 1 (acquisition) amount depends on side: buy spends amountIn of
        // ETH into quoteAsset; sell starts from leg 2's own output.
        let leg1AmountIn = amountIn;
        if (side === "sell") {
          const key = poolKeyForToken(token, quoteAsset, hook);
          if (!key) throw new Error("no pool");
          const leg2 = await publicClient.simulateContract({
            address: QUOTER_ADDRESS,
            abi: quoterAbi,
            functionName: "quoteExactInputSingle",
            args: [{ poolKey: key, zeroForOne: sellZeroForOne(token, quoteAsset), exactAmount: amountIn, hookData: "0x" }],
          });
          leg1AmountIn = (leg2.result as readonly [bigint, bigint])[0];
        }

        const [fablesOut, ramsesOut] = await Promise.all([
          hasFables
            ? quoteFablesLeg1(publicClient, routes!.fablesHopIdx, side, leg1AmountIn, quoteAsset).catch(() => undefined)
            : Promise.resolve(undefined),
          hasRamses
            ? quoteRamsesLeg1(publicClient, routes!.ramsesHopIdx, side, leg1AmountIn, quoteAsset).catch(() => undefined)
            : Promise.resolve(undefined),
        ]);
        if (cancelled) return;

        let chosenVenue: Venue | undefined;
        let leg1Out: bigint | undefined;
        if (fablesOut !== undefined && (ramsesOut === undefined || fablesOut >= ramsesOut)) {
          chosenVenue = "fables";
          leg1Out = fablesOut;
        } else if (ramsesOut !== undefined) {
          chosenVenue = "ramses";
          leg1Out = ramsesOut;
        }
        if (chosenVenue === undefined || leg1Out === undefined) {
          throw new Error("No route quoted at this size on either venue");
        }

        if (side === "buy") {
          // Leg 2: quoteAsset -> ballastToken, our own pool.
          const key = poolKeyForToken(token, quoteAsset, hook);
          if (!key) throw new Error("no pool");
          const leg2 = await publicClient.simulateContract({
            address: QUOTER_ADDRESS,
            abi: quoterAbi,
            functionName: "quoteExactInputSingle",
            args: [{ poolKey: key, zeroForOne: buyZeroForOne(token, quoteAsset), exactAmount: leg1Out, hookData: "0x" }],
          });
          if (cancelled) return;
          setQuote((leg2.result as readonly [bigint, bigint])[0]);
        } else {
          // leg1Out here IS the final ETH-equivalent amount (sell's leg 1 is
          // quoteAsset -> ETH, quoted already above).
          setQuote(leg1Out);
        }
        setVenue(chosenVenue);
        setQuoteError(undefined);
      } catch (e) {
        if (cancelled) return;
        setQuote(undefined);
        setVenue(undefined);
        setQuoteError(e instanceof Error ? e.message.split("\n")[0] : "No quote");
      } finally {
        if (!cancelled) setPhase("idle");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, token, quoteAsset, hook, routes, hasFables, hasRamses, amountIn, side]);

  const minOut = computeMinOut(quote, slippageBps);

  const swap = useCallback(async () => {
    const router = ROUTER_V2_ADDRESS;
    if (!token || !account || !publicClient || !quoteAsset || !hook || !routes || !router) return;
    if (amountIn === 0n || minOut === 0n || venue === undefined) return;
    setError(undefined);
    setTxHash(undefined);

    const send = async (write: () => Promise<`0x${string}`>) => {
      const hash = await write();
      setTxHash(hash);
      const outcome = await pollReceipt(publicClient, hash);
      if (outcome.status === "lost") {
        throw new Error(`We lost track of the transaction — check Blockscout before retrying: ${hash}`);
      }
      if (outcome.status === "reverted") {
        const replayErr = await replayForRevert(publicClient, hash);
        if (replayErr !== undefined) throw replayErr;
        throw new Error(`Transaction reverted — check Blockscout: ${hash}`);
      }
      return hash;
    };

    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const preferFables = venue === "fables";

      if (side === "buy") {
        setPhase("swapping");
        const hash = await send(() =>
          writeContractAsync({
            address: router,
            abi: ballastRouterV2Abi,
            functionName: "buyWithETH",
            args: [routes.fablesHopIdx.map(BigInt), routes.ramsesHopIdx.map(BigInt), preferFables, quoteAsset, token, hook, minOut, deadline],
            value: amountIn,
            chainId: CHAIN_ID,
          }),
        );
        setTxHash(hash);
        setPhase("success");
        invalidateChainReads();
        return;
      }

      // SELL: BallastRouterV2.sellToETH pulls the ballast token via a PLAIN
      // ERC-20 approval — no Permit2 (the router does its own transferFrom,
      // same as v1's sell/sellToETH).
      const allowance = (await publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, router],
      })) as bigint;
      if (allowance < amountIn) {
        setPhase("approving");
        await send(() =>
          writeContractAsync({
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [router, MAX_UINT256],
            chainId: CHAIN_ID,
          }),
        );
      }

      setPhase("swapping");
      const hash = await send(() =>
        writeContractAsync({
          address: router,
          abi: ballastRouterV2Abi,
          functionName: "sellToETH",
          args: [token, amountIn, quoteAsset, hook, routes.fablesHopIdx.map(BigInt), routes.ramsesHopIdx.map(BigInt), preferFables, minOut, deadline],
          chainId: CHAIN_ID,
        }),
      );
      setTxHash(hash);
      setPhase("success");
      invalidateChainReads();
    } catch (e: unknown) {
      setError(decodeTxError(e));
      setPhase("error");
    }
  }, [token, account, publicClient, quoteAsset, hook, routes, amountIn, minOut, venue, side, writeContractAsync, invalidateChainReads]);

  return {
    phase,
    quote,
    venue,
    minOut,
    quoteError,
    txHash,
    error,
    amountIn,
    canSwap: isRouterV2Configured && Boolean(account) && amountIn > 0n && quote !== undefined && venue !== undefined,
    swap,
    reset: () => {
      setPhase("idle");
      setError(undefined);
      setTxHash(undefined);
    },
  };
}

async function quoteFablesLeg1(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  hopIdx: number[],
  side: "buy" | "sell",
  amountIn: bigint,
  quoteAsset: Address,
): Promise<bigint> {
  if (!QUOTER_ADDRESS || hopIdx.length === 0) throw new Error("no fables route");
  const idx = side === "buy" ? hopIdx : reverseIdx(hopIdx);
  const entryCurrency = side === "buy" ? NATIVE_ETH_SENTINEL : quoteAsset;
  const hops = fablesHopsForIdx(idx);
  const path = buildFablesPathKeys(hops, entryCurrency);
  const res = await publicClient.simulateContract({
    address: QUOTER_ADDRESS,
    abi: quoterMultiHopAbi,
    functionName: "quoteExactInput",
    args: [{ currencyIn: entryCurrency, path, minHopPriceX36: [], amountIn, amountOutMinimum: 0n }],
  });
  return (res.result as readonly [bigint, bigint])[0];
}

async function quoteRamsesLeg1(
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>,
  routeIdx: number[],
  side: "buy" | "sell",
  amountIn: bigint,
  quoteAsset: Address,
): Promise<bigint> {
  if (!RAMSES_QUOTER_ADDRESS || routeIdx.length === 0) throw new Error("no ramses route");
  const idx = side === "buy" ? routeIdx : reverseIdx(routeIdx);
  const routeHops = ramsesRoutesForIdx(idx);
  let cur = side === "buy" ? WETH_TOKEN : quoteAsset;
  let amt = amountIn;
  for (const r of routeHops) {
    const outAddr = cur.toLowerCase() === r.tokenA.toLowerCase() ? r.tokenB : r.tokenA;
    const res = await publicClient.simulateContract({
      address: RAMSES_QUOTER_ADDRESS,
      abi: ramsesQuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn: cur, tokenOut: outAddr, amountIn: amt, tickSpacing: r.tickSpacing, sqrtPriceLimitX96: 0n }],
    });
    amt = (res.result as readonly [bigint, bigint, number, bigint])[0];
    cur = outAddr;
  }
  return amt;
}
