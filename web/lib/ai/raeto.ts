import "server-only";
import OpenAI from "openai";
import {
  RAETO_BASE_URL,
  MODEL_AUTO,
  MODEL_FALLBACK,
  REQUEST_TIMEOUT_MS,
} from "@/lib/ai/config";

// Thin server-only wrapper over the official OpenAI SDK pointed at Raeto. The key
// (process.env.RAETO_API_KEY) is read here and NOWHERE else, never returned, never
// logged. We log only request status, latency, and the x-raeto-* response headers.
//
// Routing: try raeto/auto first. If the key can't use it (403 auto_routing_locked
// or model_not_allowed) retry ONCE with openai/gpt-4o-mini. If THAT also fails the
// key's model list / $RAETO holding needs fixing — surfaced as a distinct error so
// the route can tell the human rather than show a generic "unavailable".

export type RaetoErrorKind =
  | "not_configured" // no key on the server
  | "models_misconfigured" // even the fallback model is refused — human must fix the key
  | "rate_limited" // 429 upstream
  | "payment" // 402 — out of funds
  | "auth" // 401
  | "upstream" // 5xx / network
  | "timeout"; // > REQUEST_TIMEOUT_MS

export class RaetoError extends Error {
  kind: RaetoErrorKind;
  constructor(kind: RaetoErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "RaetoError";
    this.kind = kind;
  }
}

export type RaetoMeta = {
  model: string | null; // from x-raeto-model
  tier: string | null; // from x-raeto-tier
  cost: string | null; // from x-raeto-cost (USD, string)
  latencyMs: number;
};

export type RaetoResult = { content: string; meta: RaetoMeta };

function apiKey(): string {
  const k = process.env.RAETO_API_KEY;
  if (!k) throw new RaetoError("not_configured");
  return k;
}

function client(): OpenAI {
  return new OpenAI({
    baseURL: RAETO_BASE_URL,
    apiKey: apiKey(),
    // We implement our own single, model-specific retry; the SDK must not add its own.
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
  });
}

// Map an SDK/transport error to our typed kinds. We inspect status + a stringified
// body for the two 403 shapes that mean "wrong model, retry with fallback".
function isAutoLocked(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 403) return false;
  const blob = JSON.stringify((err as { error?: unknown; message?: string })?.error ?? "") + " " + String((err as Error)?.message ?? "");
  return /auto_routing_locked|model_not_allowed/i.test(blob);
}

function classify(err: unknown): RaetoError {
  if (err instanceof RaetoError) return err;
  const status = (err as { status?: number })?.status;
  const name = (err as { name?: string })?.name;
  if (name === "APIConnectionTimeoutError" || /timeout|aborted/i.test(String((err as Error)?.message))) {
    return new RaetoError("timeout");
  }
  if (status === 401) return new RaetoError("auth");
  if (status === 402) return new RaetoError("payment");
  if (status === 429) return new RaetoError("rate_limited");
  return new RaetoError("upstream", `upstream ${status ?? "error"}`);
}

function logCall(route: string, status: number, meta: RaetoMeta): void {
  // Headers + timing ONLY. No prompt, no completion, no key.
  console.info(
    `[ai:${route}] status=${status} latency=${meta.latencyMs}ms ` +
      `x-raeto-model=${meta.model ?? "-"} x-raeto-tier=${meta.tier ?? "-"} x-raeto-cost=${meta.cost ?? "-"}`,
  );
}

type CallOpts = {
  route: string; // for logging only: "suggest" | "summary"
  system: string;
  user: string;
  maxTokens: number;
  json?: boolean;
};

async function once(
  oai: OpenAI,
  model: string,
  opts: CallOpts,
): Promise<RaetoResult> {
  const started = Date.now();
  const { data, response } = await oai.chat.completions
    .create({
      model,
      max_tokens: opts.maxTokens,
      temperature: 0.7,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    })
    .withResponse();

  const meta: RaetoMeta = {
    model: response.headers.get("x-raeto-model"),
    tier: response.headers.get("x-raeto-tier"),
    cost: response.headers.get("x-raeto-cost"),
    latencyMs: Date.now() - started,
  };
  logCall(opts.route, response.status, meta);

  const content = data.choices?.[0]?.message?.content ?? "";
  return { content, meta };
}

/** Run a completion with the auto→fallback policy. Throws RaetoError on failure. */
export async function callRaeto(opts: CallOpts): Promise<RaetoResult> {
  const oai = client();
  try {
    return await once(oai, MODEL_AUTO, opts);
  } catch (err) {
    if (!isAutoLocked(err)) throw classify(err);
    // Auto routing not permitted for this key — retry exactly once with the fallback.
    try {
      return await once(oai, MODEL_FALLBACK, opts);
    } catch (err2) {
      // Fallback also refused the model → the key's model list / holding is wrong.
      if ((err2 as { status?: number })?.status === 403) {
        throw new RaetoError("models_misconfigured");
      }
      throw classify(err2);
    }
  }
}

export type RaetoAccount = { availableUsd: number };

/** GET /v1/me — used server-side to hide the button when the balance is near 0.
 *  Never returns the key or any identifying field beyond the available balance. */
export async function getRaetoAccount(): Promise<RaetoAccount> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${RAETO_BASE_URL}/me`, {
      headers: { authorization: `Bearer ${apiKey()}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw classify({ status: res.status });
    const body = (await res.json()) as { available_usd?: number };
    return { availableUsd: typeof body.available_usd === "number" ? body.available_usd : 0 };
  } catch (err) {
    throw classify(err);
  } finally {
    clearTimeout(t);
  }
}
