import { NextRequest } from "next/server";

// Server-side JSON-RPC proxy. The dedicated (Alchemy) endpoint lives ONLY here as
// RPC_UPSTREAM_URL — never NEXT_PUBLIC_ — so its key is never in the browser
// bundle. A key shipped to the client is public no matter what Referer allowlist
// sits in front of it (Referer is trivially spoofed), so we don't ship one.
//
// The browser's wagmi transport points at this same-origin route; if the proxy
// errors, the client transport falls back to the public Robinhood RPC (see
// lib/wagmi.ts), so a proxy outage degrades to rate-limited reads, never to none.
// The raw request body is passed through unchanged so batched (array) JSON-RPC
// payloads — which Multicall3 batching produces — work as-is.
export const runtime = "nodejs";

const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

// Cap upstream time so a hung upstream becomes a fast 504 the client transport can
// fall through on — a silent hang here is exactly what timed out receipt polling.
const UPSTREAM_TIMEOUT_MS = 12_000;

function upstreamUrl(): { url: string; dedicated: boolean } {
  const dedicated = process.env.RPC_UPSTREAM_URL;
  return dedicated ? { url: dedicated, dedicated: true } : { url: PUBLIC_RPC, dedicated: false };
}

// Best-effort method summary for logs — never the full body (batched multicalls
// are huge) and never anything sensitive.
function summarizeMethods(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const methods = arr.map((r) => (r && typeof r === "object" ? r.method : "?"));
    const counts = methods.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
    return Object.entries(counts)
      .map(([k, n]) => (n > 1 ? `${k}×${n}` : k))
      .join(",");
  } catch {
    return "unparseable";
  }
}

export async function POST(req: NextRequest) {
  const { url, dedicated } = upstreamUrl();
  const body = await req.text();
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ac.signal,
      cache: "no-store",
    });
    const text = await res.text();
    const ms = Date.now() - started;
    // One structured line per request → visible in Vercel function logs. Warns
    // loudly on the two conditions that explain "reads fail": the public RPC
    // fallback is in use (no dedicated key set), or upstream returned non-2xx.
    const line = `[rpc] ${dedicated ? "dedicated" : "PUBLIC-FALLBACK"} ${res.status} ${ms}ms ${summarizeMethods(body)}`;
    if (!dedicated || !res.ok) console.warn(line);
    else console.info(line);
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    console.error(`[rpc] ${dedicated ? "dedicated" : "PUBLIC-FALLBACK"} ${timedOut ? "TIMEOUT" : "ERROR"} ${Date.now() - started}ms`, e);
    // 504/502 (not 200) so the client's fallback transport treats it as a
    // transport failure and moves to the public RPC instead of surfacing an error.
    return new Response(JSON.stringify({ error: timedOut ? "rpc upstream timeout" : "rpc upstream unreachable" }), {
      status: timedOut ? 504 : 502,
      headers: { "content-type": "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Health check — hit /api/rpc in a browser to see, without exposing the key,
// whether the proxy reaches its upstream and which upstream it is using. Returns
// the live block number so "is /api/rpc working in production" is a one-click
// answer.
export async function GET() {
  const { url, dedicated } = upstreamUrl();
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: ac.signal,
      cache: "no-store",
    });
    const json = (await res.json()) as { result?: string; error?: unknown };
    const ms = Date.now() - started;
    const blockNumber = typeof json.result === "string" ? parseInt(json.result, 16) : undefined;
    return Response.json(
      {
        ok: res.ok && blockNumber !== undefined,
        upstream: dedicated ? "dedicated" : "public-fallback",
        // Warn in the payload itself if we're on the rate-limited public RPC — the
        // most likely cause of read failures in production.
        note: dedicated ? undefined : "RPC_UPSTREAM_URL is not set — using the rate-limited public RPC. Set it to a dedicated endpoint.",
        status: res.status,
        blockNumber,
        ms,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return Response.json(
      { ok: false, upstream: dedicated ? "dedicated" : "public-fallback", error: timedOut ? "timeout" : "unreachable", ms: Date.now() - started },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  } finally {
    clearTimeout(timer);
  }
}
