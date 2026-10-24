"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import { roundupRouterAbi } from "@/lib/abis";
import { ROUNDUP_ROUTER_ADDRESS, isRoundupConfigured } from "@/lib/contracts";
import { activeChain } from "@/lib/chain";

const CHAIN_ID = activeChain.id;
// Scan a bounded recent window — round-ups are a new, low-volume feature, so a
// wide span stays well under the RPC's getLogs result cap (CLAUDE.md chain note).
const LOOKBACK_BLOCKS = 5_000_000n;
const STOCK_BOUGHT = parseAbiItem(
  "event StockBought(address indexed stock, address indexed recipient, uint256 ethIn, uint256 stockOut, bool usedFables)",
);

export type MyRoundup = {
  stock: Address;
  ethIn: bigint;
  stockOut: bigint;
  txHash: string;
  block: bigint;
};

/** The connected wallet's own round-up purchases (stock delivered to them by
 *  BasketStockBuyer). Read-only; returns an empty list (not an error) when the
 *  feature is unconfigured or the wallet has made none. The buyer address is read
 *  on-chain from the RoundupRouter, never a separate env var. */
export function useMyRoundups() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  const stockBuyerRead = useReadContract({
    address: ROUNDUP_ROUTER_ADDRESS,
    abi: roundupRouterAbi,
    functionName: "stockBuyer",
    chainId: CHAIN_ID,
    query: { enabled: isRoundupConfigured },
  });
  const stockBuyer = stockBuyerRead.data as Address | undefined;

  const q = useQuery({
    queryKey: ["my-roundups", address, stockBuyer],
    enabled: Boolean(isRoundupConfigured && address && stockBuyer && publicClient),
    staleTime: 30_000,
    queryFn: async (): Promise<MyRoundup[]> => {
      if (!publicClient || !stockBuyer || !address) return [];
      const head = await publicClient.getBlockNumber();
      const from = head > LOOKBACK_BLOCKS ? head - LOOKBACK_BLOCKS : 0n;
      const logs = await publicClient.getLogs({
        address: stockBuyer,
        event: STOCK_BOUGHT,
        args: { recipient: address },
        fromBlock: from,
        toBlock: head,
      });
      return logs
        .map((l) => ({
          stock: l.args.stock as Address,
          ethIn: (l.args.ethIn as bigint) ?? 0n,
          stockOut: (l.args.stockOut as bigint) ?? 0n,
          txHash: l.transactionHash ?? "",
          block: l.blockNumber ?? 0n,
        }))
        .sort((a, b) => (b.block > a.block ? 1 : b.block < a.block ? -1 : 0));
    },
  });

  return {
    configured: isRoundupConfigured,
    roundups: q.data ?? [],
    isLoading: q.isLoading,
  };
}
