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
import { decodeTxError } from "@/lib/txError";
import { pollReceipt, replayForRevert } from "@/lib/waitForReceipt";

const CHAIN_ID = activeChain.id;
const MAX_EXPIRATION = 2n ** 48n - 1n;
// Re-approve Permit2 if the existing allowance expires within this window — a
// still-valid-but-about-to-expire allowance would otherwise revert mid-swap.
const EXPIRATION_BUFFER_SEC = 300;

export type SwapPhase = "idle" | "quoting" | "approving" | "swapping" | "success" | "error";

/**
 * Quote + execute an exact-in swap through the forked UniversalRouter, with the ETH
 * wrap/unwrap done INSIDE the router's single execute() call (WRAP_ETH / UNWRAP_WETH
 * commands) — never a separate wrap transaction.
 *
 * The approval flow is therefore ASYMMETRIC:
 *   • BUY (native ETH → token): the router wraps msg.value to WETH it holds and
 *     settles from its own balance, so nothing is pulled from the wallet — NO
 *     approvals, a single signature (execute).
 *   • SELL (token → native ETH): the token is in the wallet, so it's pulled via
 *     Permit2 — the two approvals (token -> Permit2, then Permit2 -> router) run
 *     once when needed, then execute() swaps and unwraps to ETH.
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

    // Backoff polling that rides out a flaky RPC (Part A) instead of turning a
    // successful tx into an error. A "lost" swap is NOT auto-retried — retrying a
    // swap that actually executed would spend twice — so we surface the hash and
    // stop, letting the user check Blockscout.
    const send = async (write: () => Promise<`0x${string}`>) => {
      const hash = await write();
      setTxHash(hash);
      const outcome = await pollReceipt(publicClient, hash);
      if (outcome.status === "lost") {
        throw new Error(`We lost track of the transaction — check Blockscout before retrying: ${hash}`);
      }
      if (outcome.status === "reverted") {
        // The receipt alone gives no reason — replay the call to recover the
        // decoded revert (e.g. TRANSFER_FROM_FAILED) instead of a generic string.
        const replayErr = await replayForRevert(publicClient, hash);
        if (replayErr !== undefined) throw replayErr;
        throw new Error(`Transaction reverted — check Blockscout: ${hash}`);
      }
      return hash;
    };

    try {
      // BUY (native ETH → token): the router WRAP_ETHs msg.value into WETH it holds
      // and settles from its OWN balance, so the WETH never touches the wallet and
      // there is NO Permit2 pull — the only signature is execute() itself.
      // SELL (token → native ETH): the token lives in the wallet, so it's pulled via
      // Permit2 (the two approvals, once) and the router unwraps the WETH to ETH.
      if (side === "buy") {
        // The wrapped amount must be covered by native ETH (gas is on top).
        const nativeBalance = await publicClient.getBalance({ address: account });
        if (nativeBalance < amountIn) {
          throw new Error("Not enough ETH for this buy — reduce the amount or add ETH (gas is on top of this).");
        }
      } else {
        // 1. token -> Permit2 allowance (one-time max).
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

        // 2. Permit2 -> router allowance. Re-approve if the amount is short OR the
        //    allowance is expired / about to expire — a Permit2 allowance carries an
        //    expiration and a sufficient-but-expired one still reverts, so the
        //    expiration must be read, not just the amount.
        const [permitAmount, permitExpiration] = (await publicClient.readContract({
          address: PERMIT2_ADDRESS,
          abi: permit2Abi,
          functionName: "allowance",
          args: [account, inCur, router],
        })) as readonly [bigint, number, number];
        const nowSec = Math.floor(Date.now() / 1000);
        const permitExpired = Number(permitExpiration) <= nowSec + EXPIRATION_BUFFER_SEC;
        if (permitAmount < amountIn || permitExpired) {
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
      }

      // 3. Swap — the ETH wrap (buy) / unwrap (sell) happen INSIDE this one call
      //    (see buildV4SwapInput). `value` is the native ETH to wrap on a buy, 0 on
      //    a sell.
      const built = buildV4SwapInput({ token, side, amountIn, amountOutMinimum: minOut });
      if (!built) throw new Error("Could not build swap");
      setPhase("swapping");
      const hash = await send(() =>
        writeContractAsync({
          address: router,
          abi: universalRouterExecuteAbi,
          functionName: "execute",
          args: [built.commands, built.inputs, swapDeadline(Math.floor(Date.now() / 1000))],
          value: built.value,
          chainId: CHAIN_ID,
        }),
      );
      setTxHash(hash);
      setPhase("success");
    } catch (e: unknown) {
      setError(decodeTxError(e));
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
