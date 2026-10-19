// Central knobs for the AI helper. Kept tiny and import-safe from both client and
// server (no "server-only") so the flag can gate rendering in the browser and the
// routes can read the same limits. The KEY itself never lives here — it is read
// from process.env.RAETO_API_KEY inside server-only modules only.

/** Master feature flag. Off by default. Off = nothing AI renders or runs. This is
 *  the ONLY AI env var with a NEXT_PUBLIC_ prefix, so the client can hide the
 *  entry points without shipping any secret. */
export const AI_HELPER_ENABLED = process.env.NEXT_PUBLIC_AI_HELPER_ENABLED === "1";

/** Raeto, OpenAI-compatible. Base URL only — no key here. */
export const RAETO_BASE_URL = "https://api.raeto.cc/v1";

/** Preferred auto-routing model, and the fixed fallback the spec mandates when the
 *  key can't use auto (403 auto_routing_locked / model_not_allowed). */
export const MODEL_AUTO = "raeto/auto";
export const MODEL_FALLBACK = "openai/gpt-4o-mini";

/** Output ceilings (spec): suggest ≤ 400, summary ≤ 250. */
export const MAX_TOKENS_SUGGEST = 400;
export const MAX_TOKENS_SUMMARY = 250;

/** Per-request wall-clock budget. Anything slower is treated as "unavailable". */
export const REQUEST_TIMEOUT_MS = 8_000;

/** Input caps for the suggest route — bound prompt size before it ever leaves us. */
export const MAX_IDEA_LEN = 280;
export const MAX_FORM_FIELD_LEN = 512;

/** Our own rate limits, deliberately well under Raeto's 120 req/min. Per IP and
 *  per wallet, counted in a rolling window. */
export const RATE_LIMIT_WINDOW_SEC = 60;
export const RATE_LIMIT_SUGGEST_PER_MIN = 8;
export const RATE_LIMIT_SUMMARY_PER_MIN = 20;

/** Below this available balance (USD) we treat the helper as effectively out of
 *  funds and hide the entry points. Kept above 0 so we stop before a hard 402. */
export const MIN_AVAILABLE_USD = 0.05;
