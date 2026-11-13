"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseUnits, type Address } from "viem";
import { erc20Abi } from "@/lib/abis";
import { ballastHookV5Abi } from "@/lib/abisV5";
import {
  HOOK_ADDRESS,
  WETH_ADDRESS,
  POOL_MANAGER_ADDRESS,
  TICK_SPACING,
} from "@/lib/contracts";
import { activeChain } from "@/lib/chain";
import { poolKeyForToken, tokenIsCurrency0, poolId as computePoolId } from "@/lib/pool";
import {
  getSqrtRatioAtTick,
  tickForPrice,
  liquidityForAmount0,
  liquidityForAmount1,
} from "@/lib/tickMath";
import { readElysiumPoolState } from "@/lib/elysiumQuote";
import { decodeTxError } from "@/lib/txError";
import { pollReceipt } from "@/lib/waitForReceipt";

const CHAIN_ID = activeChain.id;

export type LimitSide = "buy" | "sell";
export type LimitPhase = "idle" | "approving" | "placing" | "cancelling" | "withdrawing" | "success" | "error";

// A placed order we track locally (keyed by wallet+chain) so "my orders" works
// without an indexer. Live status (remaining liquidity / filled) is read on-chain.
export type StoredOrder = {
  epoch: string; // bigint as string
  token: Address;
  quoteAsset: Address;
  hook: Address;
  tickLower: number;
  zeroForOne: boolean;
  side: LimitSide;
  priceLabel: string; // the target price the user entered (display only)
  createdAt: number;
};

export type LiveOrder = StoredOrder & {
  remainingLiquidity: bigint;
  filled: boolean;
  /** derived: open (has liquidity, not filled), filled (withdrawable), gone (0 liq). */
  state: "open" | "filled" | "gone";
};

function storeKey(account: Address): string {
  return `ballast:limitorders:${CHAIN_ID}:${account.toLowerCase()}`;
}

function loadOrders(account: Address): StoredOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storeKey(account));
    return raw ? (JSON.parse(raw) as StoredOrder[]) : [];
  } catch {
    return [];
  }
}

function saveOrders(account: Address, orders: StoredOrder[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storeKey(account), JSON.stringify(orders));
  } catch {
    /* quota / disabled — non-fatal, listing just won't persist */
  }
}

/**
 * On-chain range-order limit orders on BallastHookV5 (Elysium gen-5). A limit order
 * is a single-tick one-sided LP range that fills as price crosses it:
 *   • SELL token: provide the token into a range ABOVE the current price.
 *   • BUY token:  provide WHYPE into a range BELOW the current price.
 * The user enters a target price + input amount; we convert to (tickLower, liquidity)
 * with the canonical v4 math. place → cancel (unfilled) / withdraw (filled).
 */
export function useLimitOrders(token: Address | undefined, quoteAsset: Address | undefined = WETH_ADDRESS) {
  const { address: account } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<LimitPhase>("idle");
  const [error, setError] = useState<string | undefined>();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [orders, setOrders] = useState<LiveOrder[]>([]);
  const [currentTick, setCurrentTick] = useState<number | undefined>();

  const hook = HOOK_ADDRESS;
  const key = useMemo(
    () => (token && quoteAsset && hook ? poolKeyForToken(token, quoteAsset, hook) : undefined),
    [token, quoteAsset, hook],
  );

  // Read current pool tick so the UI can validate order side + show spot.
  useEffect(() => {
    let cancelled = false;
    if (!publicClient || !key || !POOL_MANAGER_ADDRESS) return;
    readElysiumPoolState(publicClient, POOL_MANAGER_ADDRESS, computePoolId(key)).then((s) => {
      if (!cancelled) setCurrentTick(s?.tick);
    });
    return () => {
      cancelled = true;
    };
  }, [publicClient, key]);

  // Hydrate + refresh the live status of locally-tracked orders for this token.
  const refresh = useCallback(async () => {
    if (!account || !publicClient || !hook) {
      setOrders([]);
      return;
    }
    const stored = loadOrders(account).filter((o) => !token || o.token.toLowerCase() === token.toLowerCase());
    const live = await Promise.all(
      stored.map(async (o): Promise<LiveOrder> => {
        let remainingLiquidity = 0n;
        let filled = false;
        try {
          remainingLiquidity = (await publicClient.readContract({
            address: hook,
            abi: ballastHookV5Abi,
            functionName: "epochLiquidity",
            args: [BigInt(o.epoch), account],
          })) as bigint;
          const info = (await publicClient.readContract({
            address: hook,
            abi: ballastHookV5Abi,
            functionName: "epochInfo",
            args: [BigInt(o.epoch)],
          })) as readonly [boolean, bigint, bigint, bigint];
          filled = info[0];
        } catch {
          /* read failed — leave defaults */
        }
        const state: LiveOrder["state"] = filled ? "filled" : remainingLiquidity > 0n ? "open" : "gone";
        return { ...o, remainingLiquidity, filled, state };
      }),
    );
    setOrders(live);
  }, [account, publicClient, hook, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = useCallback(
    async (write: () => Promise<`0x${string}`>) => {
      if (!publicClient) throw new Error("No client");
      const hash = await write();
      setTxHash(hash);
      const outcome = await pollReceipt(publicClient, hash);
      if (outcome.status === "lost")
        throw new Error(`We lost track of the transaction — check the explorer before retrying: ${hash}`);
      if (outcome.status === "reverted") throw new Error(`Transaction reverted — check the explorer: ${hash}`);
      return outcome.receipt;
    },
    [publicClient],
  );

  /** Place a limit order at `priceStr` (WHYPE per token) for `amountStr` of input. */
  const place = useCallback(
    async (side: LimitSide, priceStr: string, amountStr: string) => {
      setError(undefined);
      setTxHash(undefined);
      if (!token || !quoteAsset || !hook || !key || !account || !publicClient) return;
      try {
        const price = Number(priceStr);
        const amount = parseUnits(amountStr || "0", 18);
        if (!(price > 0) || amount <= 0n) throw new Error("Enter a price and amount");

        const tokIs0 = tokenIsCurrency0(token, quoteAsset);
        // Provided currency: token on a sell, quote on a buy.
        const providedIsCurrency0 = side === "sell" ? tokIs0 : !tokIs0;
        const zeroForOne = providedIsCurrency0;

        const tickLower = tickForPrice(price, tokIs0, TICK_SPACING);
        const tickUpper = tickLower + TICK_SPACING;

        // Validate the range sits entirely on the correct side of the current price
        // (the hook reverts NotSingleSided otherwise).
        if (currentTick !== undefined) {
          if (side === "sell" && tickLower <= currentTick) {
            throw new Error("Sell limit price must be above the current price.");
          }
          if (side === "buy" && tickUpper > currentTick) {
            throw new Error("Buy limit price must be below the current price.");
          }
        }

        const sqrtA = getSqrtRatioAtTick(tickLower);
        const sqrtB = getSqrtRatioAtTick(tickUpper);
        const liquidity = providedIsCurrency0
          ? liquidityForAmount0(amount, sqrtA, sqrtB)
          : liquidityForAmount1(amount, sqrtA, sqrtB);
        if (liquidity <= 0n) throw new Error("Amount too small for a limit order at this price.");

        const inputCurrency = side === "sell" ? token : quoteAsset;
        // The hook pulls the input currency directly (ERC-20 approve to the hook).
        const allowance = (await publicClient.readContract({
          address: inputCurrency,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account, hook],
        })) as bigint;
        if (allowance < amount) {
          setPhase("approving");
          await send(() =>
            writeContractAsync({
              address: inputCurrency,
              abi: erc20Abi,
              functionName: "approve",
              args: [hook, amount],
              chainId: CHAIN_ID,
            }),
          );
        }

        setPhase("placing");
        const receipt = await send(() =>
          writeContractAsync({
            address: hook,
            abi: ballastHookV5Abi,
            functionName: "place",
            args: [key, tickLower, zeroForOne, liquidity],
            chainId: CHAIN_ID,
          }),
        );

        // Recover the epoch from the Place event.
        let epoch: bigint | undefined;
        for (const log of receipt!.logs) {
          try {
            const { decodeEventLog } = await import("viem");
            const parsed = decodeEventLog({ abi: ballastHookV5Abi, ...log });
            if (parsed.eventName === "Place") {
              epoch = parsed.args.epoch as bigint;
              break;
            }
          } catch {
            /* not our event */
          }
        }
        if (epoch !== undefined) {
          const order: StoredOrder = {
            epoch: epoch.toString(),
            token,
            quoteAsset,
            hook,
            tickLower,
            zeroForOne,
            side,
            priceLabel: priceStr,
            createdAt: Math.floor(Date.now() / 1000),
          };
          const existing = loadOrders(account).filter((o) => o.epoch !== order.epoch || o.hook !== order.hook);
          saveOrders(account, [order, ...existing]);
        }
        setPhase("success");
        await refresh();
      } catch (e) {
        setError(decodeTxError(e));
        setPhase("error");
      }
    },
    [token, quoteAsset, hook, key, account, publicClient, currentTick, writeContractAsync, send, refresh],
  );

  const cancel = useCallback(
    async (order: LiveOrder) => {
      setError(undefined);
      if (!account || !hook) return;
      const orderKey = poolKeyForToken(order.token, order.quoteAsset, order.hook);
      if (!orderKey) return;
      try {
        setPhase("cancelling");
        await send(() =>
          writeContractAsync({
            address: hook,
            abi: ballastHookV5Abi,
            functionName: "cancel",
            args: [orderKey, order.tickLower, order.zeroForOne, account],
            chainId: CHAIN_ID,
          }),
        );
        setPhase("success");
        await refresh();
      } catch (e) {
        setError(decodeTxError(e));
        setPhase("error");
      }
    },
    [account, hook, writeContractAsync, send, refresh],
  );

  const withdraw = useCallback(
    async (order: LiveOrder) => {
      setError(undefined);
      if (!account || !hook) return;
      try {
        setPhase("withdrawing");
        await send(() =>
          writeContractAsync({
            address: hook,
            abi: ballastHookV5Abi,
            functionName: "withdraw",
            args: [BigInt(order.epoch), account],
            chainId: CHAIN_ID,
          }),
        );
        setPhase("success");
        await refresh();
      } catch (e) {
        setError(decodeTxError(e));
        setPhase("error");
      }
    },
    [account, hook, writeContractAsync, send, refresh],
  );

  return {
    phase,
    error,
    txHash,
    orders,
    currentTick,
    place,
    cancel,
    withdraw,
    refresh,
    reset: () => {
      setPhase("idle");
      setError(undefined);
      setTxHash(undefined);
    },
  };
}
