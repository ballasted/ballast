import "server-only";
import { GT_NETWORK, type Trade } from "@/lib/market";

// Server-only GeckoTerminal helpers shared by /api/trades and /api/trending, so
// pool resolution and trade normalization live in ONE place. Never imported by the
// client (keys/rate-limit stay server-side; the browser hits our proxies).
const GT = "https://api.geckoterminal.com/api/v2";
const TIMEOUT_MS = 8_000;

function withTimeout(): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

// Deepest/most-relevant pool address for a token, or null if GeckoTerminal hasn't
// indexed one yet. GeckoTerminal returns pools already ordered by relevance.
export async function resolveTopPool(token: string): Promise<string | null> {
  const { signal, done } = withTimeout();
  try {
    const res = await fetch(`${GT}/networks/${GT_NETWORK}/tokens/${token}/pools`, {
      headers: { Accept: "application/json" },
      signal,
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ attributes?: { address?: string } }> };
    return json.data?.[0]?.attributes?.address ?? null;
  } catch {
    return null;
  } finally {
    done();
  }
}

type GtTrade = {
  attributes?: {
    kind?: string;
    block_timestamp?: string;
    tx_hash?: string;
    tx_from_address?: string;
    from_token_amount?: string;
    to_token_amount?: string;
    price_from_in_usd?: string;
    price_to_in_usd?: string;
    volume_in_usd?: string;
    from_token_address?: string;
    to_token_address?: string;
  };
};

// Recent trades for a pool, normalized and with direction derived from the token
// addresses (not GeckoTerminal's pool-relative `kind`), so "buy" always means the
// launch token was bought. Returns [] on any failure.
export async function fetchPoolTrades(pool: string, token: string): Promise<Trade[]> {
  const { signal, done } = withTimeout();
  try {
    const res = await fetch(`${GT}/networks/${GT_NETWORK}/pools/${pool}/trades`, {
      headers: { Accept: "application/json" },
      signal,
      next: { revalidate: 30 },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: GtTrade[] };
    const tok = token.toLowerCase();
    const out: Trade[] = [];
    for (const t of json.data ?? []) {
      const a = t.attributes;
      if (!a) continue;
      const to = (a.to_token_address ?? "").toLowerCase();
      const from = (a.from_token_address ?? "").toLowerCase();
      const isBuy = to === tok; // token received → someone bought it
      const isSell = from === tok;
      if (!isBuy && !isSell) continue; // trade doesn't involve this token
      out.push({
        kind: isBuy ? "buy" : "sell",
        ts: a.block_timestamp ? Math.floor(new Date(a.block_timestamp).getTime() / 1000) : 0,
        txHash: a.tx_hash ?? "",
        wallet: (a.tx_from_address ?? "").toLowerCase(),
        tokenAmount: num(isBuy ? a.to_token_amount : a.from_token_amount),
        volumeUsd: num(a.volume_in_usd),
        priceUsd: num(isBuy ? a.price_to_in_usd : a.price_from_in_usd),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    done();
  }
}
