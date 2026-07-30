import { NextRequest } from "next/server";
import { BLOCKSCOUT_URL } from "@/lib/blockscout";

// Protocol-wide UNIQUE holders across our tokens, from Blockscout. The per-token
// route reports a count that double-counts a wallet holding several launches, so a
// "unique addresses across our tokens" figure has to union the actual holder
// addresses. We page each token's holder list (capped) and union non-contract
// addresses — the pool/seeder LP is a contract, so it's excluded from a human
// "holders" count. `exact` is false if any token had more pages than the cap or a
// page failed, so the UI can present the number as a floor rather than a total.
export const runtime = "nodejs";
export const revalidate = 45;

const TIMEOUT_MS = 9_000;
const MAX_PAGES = 4; // ~200 holders/token — ample for this chain; caps a runaway.

export type ProtocolHoldersData = {
  available: boolean;
  source: "Blockscout";
  reason?: "no-token" | "unreachable";
  fetchedAt?: number;
  uniqueHolders?: number;
  exact?: boolean;
};

type BsHolderItem = { address?: { hash?: string; is_contract?: boolean } };

export async function GET(req: NextRequest) {
  const tokens = (req.nextUrl.searchParams.get("tokens") ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^0x[0-9a-f]{40}$/.test(t));

  if (tokens.length === 0) {
    return Response.json(
      { available: false, source: "Blockscout", reason: "no-token" } satisfies ProtocolHoldersData,
      { status: 400 },
    );
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const opts = { headers: { Accept: "application/json" }, signal: ac.signal, next: { revalidate } };

  try {
    const unique = new Set<string>();
    let exact = true;
    let anyOk = false;

    for (const token of tokens) {
      const base = `${BLOCKSCOUT_URL}/api/v2/tokens/${token}/holders`;
      let url = base;
      let pages = 0;
      for (;;) {
        const r = await fetch(url, opts);
        // 404 = Blockscout hasn't indexed this (too new / no transfers): 0 holders,
        // a real state, not a failure.
        if (r.status === 404) {
          anyOk = true;
          break;
        }
        if (!r.ok) {
          exact = false;
          break;
        }
        anyOk = true;
        const j = (await r.json()) as { items?: BsHolderItem[]; next_page_params?: Record<string, unknown> | null };
        for (const it of j.items ?? []) {
          const addr = (it.address?.hash ?? "").toLowerCase();
          if (addr && !it.address?.is_contract) unique.add(addr);
        }
        pages += 1;
        const np = j.next_page_params;
        if (!np) break;
        if (pages >= MAX_PAGES) {
          exact = false;
          break;
        }
        const qs = new URLSearchParams(
          Object.fromEntries(Object.entries(np).map(([k, v]) => [k, String(v)])),
        ).toString();
        url = `${base}?${qs}`;
      }
    }

    if (!anyOk) {
      return Response.json(
        { available: false, source: "Blockscout", reason: "unreachable" } satisfies ProtocolHoldersData,
        { status: 502 },
      );
    }

    return Response.json(
      {
        available: true,
        source: "Blockscout",
        fetchedAt: Math.floor(Date.now() / 1000),
        uniqueHolders: unique.size,
        exact,
      } satisfies ProtocolHoldersData,
      { headers: { "cache-control": "s-maxage=45, stale-while-revalidate=90" } },
    );
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return Response.json(
      { available: false, source: "Blockscout", reason: "unreachable" } satisfies ProtocolHoldersData,
      { status: timedOut ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
