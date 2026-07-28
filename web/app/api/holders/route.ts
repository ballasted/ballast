import { NextRequest } from "next/server";
import { BLOCKSCOUT_URL, type Holder, type HoldersData } from "@/lib/blockscout";

// Server proxy to Blockscout for a token's holders + counters. Server-side so the
// browser never hits Blockscout directly (one place to respect its ~10 rps/IP fair
// limit) and responses are cached. On any failure it returns available:false with a
// reason — the UI then degrades honestly, never a zero or a stale count.
export const runtime = "nodejs";
// Holder balances move only on transfers; 45s keeps us far under the rate limit
// while staying current enough for a disclosure surface.
export const revalidate = 45;

const TIMEOUT_MS = 8_000;
const TOP_N = 25;

type BsAddress = {
  hash?: string;
  is_contract?: boolean;
  name?: string | null;
  metadata?: { tags?: Array<{ name?: string }> } | null;
};
type BsHolderItem = { address?: BsAddress; value?: string };
type BsToken = { total_supply?: string; decimals?: string; holders_count?: string; holders?: string };

function labelOf(a: BsAddress | undefined): string | undefined {
  if (!a) return undefined;
  if (a.name) return a.name;
  const tag = a.metadata?.tags?.find((t) => t.name)?.name;
  return tag ?? undefined;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")?.toLowerCase();
  if (!token || !/^0x[0-9a-f]{40}$/.test(token)) {
    return Response.json(
      { available: false, source: "Blockscout", reason: "no-token", holders: [] } satisfies HoldersData,
      { status: 400 },
    );
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const opts = { headers: { Accept: "application/json" }, signal: ac.signal, next: { revalidate } };
  try {
    const [tokRes, holdersRes] = await Promise.all([
      fetch(`${BLOCKSCOUT_URL}/api/v2/tokens/${token}`, opts),
      fetch(`${BLOCKSCOUT_URL}/api/v2/tokens/${token}/holders`, opts),
    ]);

    // 404 = Blockscout hasn't seen this token (too new / no transfers). Honest state.
    if (tokRes.status === 404 && holdersRes.status === 404) {
      return Response.json(
        { available: false, source: "Blockscout", reason: "not-found", holders: [], fetchedAt: nowSec() } satisfies HoldersData,
        { headers: { "cache-control": "s-maxage=45" } },
      );
    }
    if (!tokRes.ok && !holdersRes.ok) {
      return Response.json(
        { available: false, source: "Blockscout", reason: "unreachable", holders: [] } satisfies HoldersData,
        { status: 502 },
      );
    }

    const tok = tokRes.ok ? ((await tokRes.json()) as BsToken) : undefined;
    const holdersJson = holdersRes.ok ? ((await holdersRes.json()) as { items?: BsHolderItem[] }) : undefined;

    const holders: Holder[] = (holdersJson?.items ?? [])
      .map((it) => ({
        address: (it.address?.hash ?? "").toLowerCase(),
        value: it.value ?? "0",
        isContract: Boolean(it.address?.is_contract),
        name: labelOf(it.address),
      }))
      .filter((h) => h.address)
      .slice(0, TOP_N);

    // holders_count is the authoritative count from Blockscout's index; the items
    // list is only the top page, so never derive the count from holders.length.
    const holdersCount =
      tok?.holders_count !== undefined
        ? Number(tok.holders_count)
        : tok?.holders !== undefined
          ? Number(tok.holders)
          : undefined;

    const data: HoldersData = {
      available: holders.length > 0 || holdersCount !== undefined,
      source: "Blockscout",
      fetchedAt: nowSec(),
      holdersCount,
      totalSupply: tok?.total_supply,
      decimals: tok?.decimals !== undefined ? Number(tok.decimals) : undefined,
      holders,
    };
    return Response.json(data, { headers: { "cache-control": "s-maxage=45, stale-while-revalidate=90" } });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return Response.json(
      { available: false, source: "Blockscout", reason: "unreachable", holders: [] } satisfies HoldersData,
      { status: timedOut ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
