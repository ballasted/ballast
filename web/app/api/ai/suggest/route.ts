import { NextRequest, NextResponse } from "next/server";
import {
  AI_HELPER_ENABLED,
  MAX_TOKENS_SUGGEST,
  MAX_IDEA_LEN,
  MAX_FORM_FIELD_LEN,
  RATE_LIMIT_SUGGEST_PER_MIN,
} from "@/lib/ai/config";
import { callRaeto, RaetoError } from "@/lib/ai/raeto";
import { SUGGEST_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { filterSuggestion, type SuggestionShape } from "@/lib/ai/guardrails";
import { rateLimit, clientIp } from "@/lib/ai/rateLimit";
import { errorStatus, unavailableBody } from "@/lib/ai/httpErrors";

// AI launch-idea helper. Suggestions ONLY — the response fills editable form fields;
// nothing is signed or submitted. Node runtime (SDK + env). Off entirely unless the
// feature flag is on.
export const runtime = "nodejs";

function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max).trim() : "";
}

export async function POST(req: NextRequest) {
  if (!AI_HELPER_ENABLED) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const idea = clip(body.idea, MAX_IDEA_LEN);
  if (idea.length < 3) {
    return NextResponse.json({ error: "Describe your idea in a few words first." }, { status: 400 });
  }

  // Rate limit by IP and (if provided) wallet. Both must pass.
  const ip = clientIp(req.headers);
  const wallet = typeof body.wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(body.wallet)
    ? body.wallet.toLowerCase()
    : undefined;
  const ipHit = await rateLimit("suggest:ip", ip, RATE_LIMIT_SUGGEST_PER_MIN);
  const walletHit = wallet ? await rateLimit("suggest:wallet", wallet, RATE_LIMIT_SUGGEST_PER_MIN) : null;
  const limited = !ipHit.allowed || (walletHit && !walletHit.allowed);
  if (limited) {
    const resetSec = Math.max(ipHit.resetSec, walletHit?.resetSec ?? 0);
    return NextResponse.json(
      { error: "Too many requests. Try again shortly.", retryAfterSec: resetSec },
      { status: 429, headers: { "retry-after": String(resetSec) } },
    );
  }

  // Current editable form state (all optional) — lets the model refine, not reset.
  const form = (body.form ?? {}) as Record<string, unknown>;
  const userPrompt = [
    `Idea: ${idea}`,
    form.name ? `Current name: ${clip(form.name, MAX_FORM_FIELD_LEN)}` : "",
    form.symbol ? `Current ticker: ${clip(form.symbol, 16)}` : "",
    form.category ? `Category: ${clip(form.category, 32)}` : "",
    form.description ? `Current description: ${clip(form.description, MAX_FORM_FIELD_LEN)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    // Up to two attempts: if guardrails reject the first (banned copy / all names or
    // tickers blocked), regenerate ONCE before giving up.
    let suggestion: SuggestionShape | null = null;
    let lastViolations: string[] = [];
    for (let attempt = 0; attempt < 2 && !suggestion; attempt++) {
      const result = await callRaeto({
        route: "suggest",
        system: SUGGEST_SYSTEM_PROMPT,
        user: attempt === 0 ? userPrompt : `${userPrompt}\n\n(Previous attempt violated copy rules — try again, strictly.)`,
        maxTokens: MAX_TOKENS_SUGGEST,
        json: true,
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.content);
      } catch {
        lastViolations = ["invalid-json"];
        continue;
      }
      const filtered = filterSuggestion(parsed);
      if (filtered.ok) suggestion = filtered.value;
      else lastViolations = filtered.violations;
    }

    if (!suggestion) {
      // Couldn't produce clean copy — treat as unavailable rather than return junk.
      console.warn(`[ai:suggest] rejected after retries: ${lastViolations.join("; ")}`);
      return NextResponse.json(unavailableBody(), { status: 502 });
    }

    return NextResponse.json({ suggestion });
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
