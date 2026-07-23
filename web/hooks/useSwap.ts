"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseUnits, maxUint160, type Address } from "viem";
import { erc20Abi, permit2Abi, quoterAbi } from "@/lib/abis";
import {
  WETH_ADDRESS,
  QUOTER_ADDRESS,
  UNIVERSAL_ROUTER_ADDRESS,
  PERMIT2_ADDRESS,
  isSwapConfigured,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { poolKeyForToken, BUY_ZERO_FOR_ONE, SELL_ZERO_FOR_ONE } from "@/lib/pool";
import { buildV4SwapInput, swapDeadline, type SwapSide } from "@/lib/swap";
import { universalRouterExecuteAbi } from "@/lib/robinhoodRouter";

const CHAIN_ID = activeChain.id;
const MAX_EXPIRATION = 2n ** 48n - 1n;

export type SwapPhase = "idle" | "quoting" | "approving" | "swapping" | "success" | "error";

/**
 * Quote + execute an exact-in swap through the forked UniversalRouter. Input is
 * WETH (buy) or the token (sell) — both ERC-20, pulled via Permit2, so the hook
 * transparently runs the two approvals (ERC-20 -> Permit2, Permit2 -> router)
 * before the swap when needed.
 */
export function useSwap(token: Address | undefined, side: SwapSide, amountStr: string, slippageBps = 100) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<SwapPhase>("idle");
  const [quote, setQuote] = useState<bigint | undefined>();
  const [quoteError, setQuoteError] = useState<string | undefined>();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [error, setError] = useState<string | undefined>();

  const inputCurrency = side === "buy" ? WETH_ADDRESS : token;
  let amountIn = 0n;
  try {
    amountIn = amountStr ? parseUnits(amountStr, 18) : 0n; // WETH + token both 18-dec
  } catch {
    amountIn = 0n;
  }

  // Quote via V4Quoter (revert-based; simulate to read the return value).
  useEffect(() => {
    let cancelled = false;
    if (!token || !publicClient || !QUOTER_ADDRESS || amountIn === 0n) {
      setQuote(undefined);
      setQuoteError(undefined);
      return;
    }
    const key = poolKeyForToken(token);
    if (!key) return;
    setPhase("quoting");
    publicClient
      .simulateContract({
        address: QUOTER_ADDRESS,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: key,
            zeroForOne: side === "buy" ? BUY_ZERO_FOR_ONE : SELL_ZERO_FOR_ONE,
            exactAmount: amountIn,
            hookData: "0x",
          },
        ],
      })
      .then((res) => {
        if (cancelled) return;
        setQuote((res.result as readonly [bigint, bigint])[0]);
        setQuoteError(undefined);
        setPhase("idle");
      })
      .catch((e) => {
        if (cancelled) return;
        setQuote(undefined);
        setQuoteError(e instanceof Error ? e.message.split("\n")[0] : "No quote");
        setPhase("idle");
      });
    return () => {
      cancelled = true;
    };
  }, [token, publicClient, amountIn, side]);

  const minOut = quote !== undefined ? (quote * BigInt(10000 - slippageBps)) / 10000n : 0n;

  const swap = useCallback(async () => {
    if (!token || !account || !publicClient || !inputCurrency) return;
    if (!UNIVERSAL_ROUTER_ADDRESS || amountIn === 0n || minOut === 0n) return;
    const inCur = inputCurrency; // narrowed for closures
    const router = UNIVERSAL_ROUTER_ADDRESS;
    setError(undefined);
    setTxHash(undefined);

    const send = async (write: () => Promise<`0x${string}`>) => {
      const hash = await write();
      const r = await publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("Transaction reverted");
      return hash;
    };

    try {
      // 1. ERC-20 -> Permit2 allowance (one-time max).
      const erc20Allowance = (await publicClient.readContract({
        address: inCur,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account, PERMIT2_ADDRESS],
      })) as bigint;
      if (erc20Allowance < amountIn) {
        setPhase("approving");
        await send(() =>
          writeContractAsync({
            address: inCur,
            abi: erc20Abi,
            functionName: "approve",
            args: [PERMIT2_ADDRESS, maxUint160],
            chainId: CHAIN_ID,
          }),
        );
      }

      // 2. Permit2 -> router allowance.
      const [permitAmount] = (await publicClient.readContract({
        address: PERMIT2_ADDRESS,
        abi: permit2Abi,
        functionName: "allowance",
        args: [account, inCur, router],
      })) as readonly [bigint, number, number];
      if (permitAmount < amountIn) {
        setPhase("approving");
        await send(() =>
          writeContractAsync({
            address: PERMIT2_ADDRESS,
            abi: permit2Abi,
            functionName: "approve",
            args: [inCur, router, maxUint160, Number(MAX_EXPIRATION)],
            chainId: CHAIN_ID,
          }),
        );
      }

      // 3. Swap.
      const built = buildV4SwapInput({ token, side, amountIn, amountOutMinimum: minOut });
      if (!built) throw new Error("Could not build swap");
      setPhase("swapping");
      const hash = await send(() =>
        writeContractAsync({
          address: router,
          abi: universalRouterExecuteAbi,
          functionName: "execute",
          args: [built.commands, built.inputs, swapDeadline(Math.floor(Date.now() / 1000))],
          chainId: CHAIN_ID,
        }),
      );
      setTxHash(hash);
      setPhase("success");
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      setError(/rejected|denied/i.test(raw) ? "You rejected the transaction." : (raw.split("\n")[0] ?? raw).slice(0, 200));
      setPhase("error");
    }
  }, [token, account, publicClient, inputCurrency, amountIn, minOut, side, writeContractAsync]);

  return {
    phase,
    quote,
    minOut,
    quoteError,
    txHash,
    error,
    amountIn,
    canSwap: isSwapConfigured && Boolean(account) && amountIn > 0n && quote !== undefined,
    swap,
    reset: () => {
      setPhase("idle");
      setError(undefined);
      setTxHash(undefined);
    },
  };
}
