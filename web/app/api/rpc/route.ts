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

export async function POST(req: NextRequest) {
  const upstream = process.env.RPC_UPSTREAM_URL || PUBLIC_RPC;
  const body = await req.text();
  try {
    const res = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    // Signal upstream failure so the client transport falls back to the public RPC.
    return new Response(JSON.stringify({ error: "rpc upstream unreachable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}
