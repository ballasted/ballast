import "server-only";
import { createPublicClient, http, defineChain, type Address } from "viem";
import { ballastFactoryAbi } from "@/lib/abis";
import { FACTORY_ADDRESSES } from "@/lib/contracts";

// Server-side chain reads for the API routes (trending, analytics). Enumerates the
// multi-factory launch union the SAME way useProjects/heroStats do, so every
// server-derived total reconciles with what Discover lists. Single source of the
// viem client + chain def for server routes.
const RPC = process.env.RPC_UPSTREAM_URL || "https://rpc.mainnet.chain.robinhood.com";

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export function serverClient() {
  return createPublicClient({ chain, transport: http(RPC) });
}

export type LaunchRow = { token: Address; treasury: Address; creator: Address };

// Every launch across the factory union, deduped by token (newest factory wins),
// or [] if unconfigured / on any read failure. Never throws.
export async function listLaunches(): Promise<LaunchRow[]> {
  if (FACTORY_ADDRESSES.length === 0) return [];
  try {
    const client = serverClient();
    const counts = await client.multicall({
      contracts: FACTORY_ADDRESSES.map((address) => ({
        address,
        abi: ballastFactoryAbi,
        functionName: "launchCount" as const,
      })),
    });
    const per = counts.map((r) => (r.status === "success" ? Number(r.result as bigint) : 0));
    const refs: { f: Address; i: number }[] = [];
    FACTORY_ADDRESSES.forEach((f, k) => {
      const c = per[k] ?? 0;
      for (let i = 0; i < c; i++) refs.push({ f, i });
    });
    if (refs.length === 0) return [];

    const rows = await client.multicall({
      contracts: refs.map((ref) => ({
        address: ref.f,
        abi: ballastFactoryAbi,
        functionName: "launches" as const,
        args: [BigInt(ref.i)],
      })),
    });
    const seen = new Set<string>();
    const out: LaunchRow[] = [];
    rows.forEach((r) => {
      if (r.status !== "success") return;
      const [token, treasury, creator] = r.result as readonly [Address, Address, Address];
      const key = token.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ token, treasury, creator });
    });
    return out;
  } catch {
    return [];
  }
}
