import { NextRequest, NextResponse } from "next/server";
import type { Address } from "viem";
import {
  AI_HELPER_ENABLED,
  MAX_TOKENS_SUMMARY,
  RATE_LIMIT_SUMMARY_PER_MIN,
} from "@/lib/ai/config";
import { callRaeto, RaetoError } from "@/lib/ai/raeto";
import { SUMMARY_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { isSummaryClean } from "@/lib/ai/guardrails";
import { rateLimit, clientIp } from "@/lib/ai/rateLimit";
import { assembleSummaryData, factsToPrompt } from "@/lib/ai/summaryData";
import { errorStatus, unavailableBody } from "@/lib/ai/httpErrors";

// Plain-English, AI-generated summary of a token's ON-CHAIN data. Node runtime
// (chain reads + SDK). Cached per token + block bucket so repeat views don't re-bill
// Raeto for the same facts. Off unless the feature flag is on.
export const runtime = "nodejs";

// Process-local cache. Keyed by `${token}:${blockBucket}` so it naturally expires as
// the chain advances (~1 min/bucket). Small cap to bound memory on a warm lambda.
const CACHE = new Map<string, string>();
const CACHE_MAX = 500;

function cacheGet(key: string): string | undefined {
  return CACHE.get(key);
}
function cacheSet(key: string, val: string): void {
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string);
  CACHE.set(key, val);
}

export async function POST(req: NextRequest) {
  if (!AI_HELPER_ENABLED) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return NextResponse.json({ error: "A valid token address is required." }, { status: 400 });
  }

  const ip = clientIp(req.headers);
  const hit = await rateLimit("summary:ip", ip, RATE_LIMIT_SUMMARY_PER_MIN);
  if (!hit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Try again shortly.", retryAfterSec: hit.resetSec },
      { status: 429, headers: { "retry-after": String(hit.resetSec) } },
    );
  }

  const { facts, blockBucket } = await assembleSummaryData(token as Address);
  if (!facts.found) {
    return NextResponse.json({ error: "Not a BALLAST token on this chain." }, { status: 404 });
  }

  const cacheKey = `${token.toLowerCase()}:${blockBucket}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return NextResponse.json(
      { summary: cached, cached: true },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  }

  try {
    let summary: string | null = null;
    for (let attempt = 0; attempt < 2 && !summary; attempt++) {
      const result = await callRaeto({
        route: "summary",
        system: SUMMARY_SYSTEM_PROMPT,
        user: factsToPrompt(facts),
        maxTokens: MAX_TOKENS_SUMMARY,
      });
      const text = result.content.trim();
      if (text && isSummaryClean(text)) summary = text;
    }

    if (!summary) {
      console.warn("[ai:summary] rejected after retries (banned copy)");
      return NextResponse.json(unavailableBody(), { status: 502 });
    }

    cacheSet(cacheKey, summary);
    return NextResponse.json(
      { summary, cached: false },
      { headers: { "cache-control": "public, max-age=60" } },
    );
  } catch (err) {
    if (err instanceof RaetoError && err.kind === "models_misconfigured") {
      return NextResponse.json(
        { error: "AI helper is misconfigured (the API key's model list needs attention).", code: "models_misconfigured" },
        { status: 503 },
      );
    }
    return NextResponse.json(unavailableBody(), { status: errorStatus(err) });
  }
}
