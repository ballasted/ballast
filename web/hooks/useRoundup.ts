"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  usePublicClient,
  useWalletClient,
  useSendCalls,
  useCapabilities,
  useSendTransaction,
  useReadContract,
} from "wagmi";
import { waitForCallsStatus } from "viem/actions";
import type { Address } from "viem";
import { roundupRouterAbi, basketStockBuyerAbi } from "@/lib/abis";
import { ROUNDUP_ROUTER_ADDRESS, isRoundupConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { swapDeadline } from "@/lib/swap";
import { supportsAtomicBatch } from "@/lib/eip5792";
import { decodeTxError } from "@/lib/txError";
import {
  buildRoundupBuyCall,
  encodeStockRoute,
  isRoundupRoutable,
  preferFablesFor,
  roundupMinOut,
} from "@/lib/roundup";
import { routerV2RoutesFor } from "@/lib/routerV2";

const CHAIN_ID = activeChain.id;

type Phase = "idle" | "confirming" | "success" | "error";

export type RoundupPreview = {
  /** On + has a route + non-zero ETH — i.e. a round-up leg will actually be added. */
  active: boolean;
  routable: boolean;
  roundupEthWei: bigint;
  stock?: Address;
  /** Simulated stock received (from a live eth_call against BasketStockBuyer). */
  stockOut?: bigint;
  /** Slippage-floored minimum passed to the contract. */
  minStockOut?: bigint;
  /** Will the two legs run as ONE atomic confirmation (EIP-5792) or two txs. */
  atomic: boolean;
};

/**
 * Round-up execution: batches the user's main ETH BUY with a stock-only round-up
 * (BasketStockBuyer.buyStockWithETH, delivered to the trader's own wallet) via
 * EIP-5792 wallet_sendCalls, falling back to two sequential txs when the wallet
 * can't batch. The preview is a LIVE simulation of the stock buy — that both
 * powers show-before-sign and verifies the route encoding + minOut against the
 * deployed contract. Entirely gated on NEXT_PUBLIC_ROUNDUP_ROUTER.
 */
export function useRoundup(args: {
  mainAmountIn: bigint; // the main buy's ETH (wei)
  bps: number; // round-up size in basis points (0 = off)
  stock?: Address;
  enabled: boolean; // toggle on
  slippageBps: number;
  /** The main native-ETH buy as a raw call (from useSwap.buildBuyCall). */
  buildBuyCall: () => { to: Address; data: `0x${string}`; value: bigint } | undefined;
}) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID });
  const { sendCallsAsync } = useSendCalls();
  const { sendTransactionAsync } = useSendTransaction();
  const { data: capabilities } = useCapabilities({ account, query: { enabled: Boolean(account) } });

  const roundupEthWei = args.bps > 0 ? (args.mainAmountIn * BigInt(args.bps)) / 10_000n : 0n;
  const routable = Boolean(args.stock) && isRoundupRoutable(args.stock!);
  const active =
    isRoundupConfigured && args.enabled && args.bps > 0 && roundupEthWei > 0n && routable;

  const atomic = supportsAtomicBatch(capabilities as Parameters<typeof supportsAtomicBatch>[0], CHAIN_ID);

  // BasketStockBuyer address — read on-chain from the RoundupRouter (no env var).
  const stockBuyerRead = useReadContract({
    address: ROUNDUP_ROUTER_ADDRESS,
    abi: roundupRouterAbi,
    functionName: "stockBuyer",
    chainId: CHAIN_ID,
    query: { enabled: isRoundupConfigured },
  });
  const stockBuyer = stockBuyerRead.data as Address | undefined;

  const [preview, setPreview] = useState<RoundupPreview>({ active: false, routable: false, roundupEthWei: 0n, atomic: false });
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string>();

  // Live simulation → stockOut + minStockOut (and verifies the encoding).
  useEffect(() => {
    let cancelled = false;
    const base: RoundupPreview = { active, routable, roundupEthWei, stock: args.stock, atomic };
    if (!active || !account || !publicClient || !stockBuyer || !args.stock) {
      setPreview(base);
      return;
    }
    const stock = args.stock;
    const routes = routerV2RoutesFor(stock);
    if (!routes) {
      setPreview({ ...base, routable: false });
      return;
    }
    const route = encodeStockRoute({
      fablesHopIdx: routes.fablesHopIdx,
      ramsesHopIdx: routes.ramsesHopIdx,
      preferFables: preferFablesFor(stock),
      deadline: swapDeadline(Math.floor(Date.now() / 1000)),
    });
    (async () => {
      try {
        const sim = await publicClient.simulateContract({
          address: stockBuyer,
          abi: basketStockBuyerAbi,
          functionName: "buyStockWithETH",
          args: [stock, account, 1n, route],
          value: roundupEthWei,
          account,
        });
        if (cancelled) return;
        const stockOut = sim.result as bigint;
        setPreview({ ...base, stockOut, minStockOut: roundupMinOut(stockOut, args.slippageBps) });
      } catch {
        // No quote yet / thin pool — keep active but without a stockOut; execute
        // will block until a simulation succeeds (never sends an unprotected leg).
        if (!cancelled) setPreview(base);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, routable, atomic, account, publicClient, stockBuyer, args.stock, roundupEthWei, args.slippageBps]);

  const execute = useCallback(async (): Promise<{ ok: boolean; hash?: string }> => {
    if (!active || !account || !publicClient || !stockBuyer || !args.stock) return { ok: false };
    const mainCall = args.buildBuyCall();
    if (!mainCall) {
      setError("Round-ups only apply to an ETH buy.");
      setPhase("error");
      return { ok: false };
    }
    if (preview.minStockOut === undefined) {
      setError("No round-up quote yet — try again in a moment.");
      setPhase("error");
      return { ok: false };
    }
    const roundupCall = buildRoundupBuyCall({
      stockBuyer,
      stock: args.stock,
      recipient: account, // the trader's OWN wallet — never a Ballast contract
      roundupEthWei,
      minStockOut: preview.minStockOut,
      preferFables: preferFablesFor(args.stock),
      deadline: swapDeadline(Math.floor(Date.now() / 1000)),
    });
    if (!roundupCall) {
      setError("No round-up route for this stock.");
      setPhase("error");
      return { ok: false };
    }

    setError(undefined);
    setPhase("confirming");
    try {
      if (atomic && walletClient) {
        // One all-or-nothing confirmation: main swap + round-up together.
        const { id } = await sendCallsAsync({ calls: [mainCall, roundupCall], forceAtomic: true });
        const res = await waitForCallsStatus(walletClient, { id });
        if (res.status !== "success") throw new Error(`Round-up batch did not succeed (${res.status})`);
        setPhase("success");
        return { ok: true, hash: id };
      }
      // Fallback: two clear transactions — the main swap first, then the round-up.
      const h1 = await sendTransactionAsync({ to: mainCall.to, data: mainCall.data, value: mainCall.value, chainId: CHAIN_ID });
      await publicClient.waitForTransactionReceipt({ hash: h1 });
      const h2 = await sendTransactionAsync({ to: roundupCall.to, data: roundupCall.data, value: roundupCall.value, chainId: CHAIN_ID });
      await publicClient.waitForTransactionReceipt({ hash: h2 });
      setPhase("success");
      return { ok: true, hash: h2 };
    } catch (e) {
      setError(decodeTxError(e));
      setPhase("error");
      return { ok: false };
    }
  }, [active, account, publicClient, stockBuyer, args, roundupEthWei, preview.minStockOut, atomic, walletClient, sendCallsAsync, sendTransactionAsync]);

  return { preview, phase, error, execute, reset: () => { setPhase("idle"); setError(undefined); } };
}
