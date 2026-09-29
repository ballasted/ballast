import { NextRequest } from "next/server";
import {
  deriveSecurityCheck,
  goPlusApiUrl,
  GOPLUS_MAX_ADDRESSES_PER_CALL,
  type GoPlusApiResponse,
  type GoPlusRawEntry,
  type SecurityCheckResult,
} from "@/lib/goplus";

// Server proxy to GoPlus's token_security API for this chain (4663). Server-side
// so the browser never hits GoPlus directly on every page load, and so a client
// can request a BATCH of addresses (the /app/security dashboard) in one call
// instead of one request per card. GoPlus publishes no documented rate limit for
// key-less calls (checked their docs directly), so this errs conservative: a
// 2-minute edge cache plus a request-level timeout, rather than hitting it fresh
// on every render.
//
// On ANY failure (unreachable, timeout, bad response) this returns
// available:false and an EMPTY results map — never a cached/fabricated result.
// The UI's honest state for that is "Unknown — check unavailable" (CLAUDE.md /
// the standing "no fake greens" instruction), not a default pass.
export const runtime = "nodejs";

const TIMEOUT_MS = 8_000;
const REVALIDATE_SEC = 120;

export type SecurityCheckApiResponse = {
  fetchedAt: number; // unix seconds
  source: "GoPlus";
  apiUrl?: string; // the exact raw GoPlus URL queried — the proof link (raw JSON, inspectable)
  available: boolean;
  reason?: "no-tokens" | "unreachable" | "timeout" | "bad-response";
  results: Record<string, SecurityCheckResult>; // keyed by lowercase address
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function GET(req: NextRequest) {
  const fetchedAt = nowSec();
  const raw = req.nextUrl.searchParams.get("tokens") ?? "";
  const tokens = [
    ...new Set(
      raw
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => /^0x[0-9a-f]{40}$/.test(t)),
    ),
  ];

  if (tokens.length === 0) {
    return Response.json(
      { fetchedAt, source: "GoPlus", available: false, reason: "no-tokens", results: {} } satisfies SecurityCheckApiResponse,
      { status: 400 },
    );
  }

  const batches = chunk(tokens, GOPLUS_MAX_ADDRESSES_PER_CALL);
  // The proof link always points at the FULL requested set (even if it took
  // multiple upstream calls to satisfy) — the sole address is the common case,
  // and it's still exactly what a visitor can paste in a browser to verify.
  const apiUrl = goPlusApiUrl(tokens);

  try {
    const batchResults = await Promise.all(
      batches.map(async (addrs) => {
        const res = await fetch(goPlusApiUrl(addrs), {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          next: { revalidate: REVALIDATE_SEC },
        });
        if (!res.ok) throw new Error(`goplus ${res.status}`);
        const json = (await res.json()) as GoPlusApiResponse;
        if (json.code !== 1) throw new Error(`goplus code ${json.code}: ${json.message}`);
        return json.result ?? {};
      }),
    );

    const merged: Record<string, SecurityCheckResult> = {};
    for (const addr of tokens) {
      let entry: GoPlusRawEntry | undefined;
      for (const b of batchResults) {
        if (addr in b) {
          entry = b[addr];
          break;
        }
      }
      merged[addr] = deriveSecurityCheck(entry);
    }

    const body: SecurityCheckApiResponse = { fetchedAt, source: "GoPlus", apiUrl, available: true, results: merged };
    return Response.json(body, { headers: { "cache-control": `s-maxage=${REVALIDATE_SEC}, stale-while-revalidate=180` } });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    const body: SecurityCheckApiResponse = {
      fetchedAt,
      source: "GoPlus",
      apiUrl,
      available: false,
      reason: timedOut ? "timeout" : "unreachable",
      results: {},
    };
    return Response.json(body, { status: timedOut ? 504 : 502 });
  }
}
