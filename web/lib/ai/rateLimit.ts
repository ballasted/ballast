import "server-only";
import { RATE_LIMIT_WINDOW_SEC } from "@/lib/ai/config";

// Rate limiting for the AI routes, per IP and per wallet. Serverless-safe: when
// Upstash Redis REST is configured (UPSTASH_REDIS_REST_URL + _TOKEN) it uses a
// fixed-window counter there so the limit holds ACROSS lambda instances. Without
// it (local dev, or before the human provisions Upstash) it degrades to an
// in-process Map — correct on a single instance, best-effort on many. We log once
// which backend is active so the gap is visible, never silent.

type Decision = { allowed: boolean; remaining: number; resetSec: number };

// Accept either the native Upstash var names OR the names the Vercel Marketplace
// Upstash (Redis/KV) integration injects (KV_REST_API_URL / KV_REST_API_TOKEN) —
// both point at the same Upstash REST endpoint + token, so the fixed-window counter
// below works unchanged against either. Native names win if both are set.
const UP_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const RATE_LIMIT_DURABLE = Boolean(UP_URL && UP_TOKEN);

let announced = false;
function announceBackendOnce() {
  if (announced) return;
  announced = true;
  // Log the active backend ONCE — never the URL or token. Lets the Preview/Prod
  // logs confirm durable (Upstash/KV) vs the in-memory fallback at a glance.
  if (RATE_LIMIT_DURABLE) {
    console.info("[ai:ratelimit] backend=upstash-rest (durable, cross-instance)");
  } else {
    console.warn(
      "[ai:ratelimit] backend=in-memory (per-instance only). " +
        "Set UPSTASH_REDIS_REST_URL/_TOKEN or the KV_REST_API_URL/_TOKEN integration vars for durable limits.",
    );
  }
}

// ── In-memory fallback ────────────────────────────────────────────────────────
const mem = new Map<string, { count: number; expires: number }>();

function memLimit(key: string, limit: number, windowSec: number): Decision {
  const now = Date.now();
  const e = mem.get(key);
  if (!e || e.expires <= now) {
    mem.set(key, { count: 1, expires: now + windowSec * 1000 });
    return { allowed: true, remaining: limit - 1, resetSec: windowSec };
  }
  e.count += 1;
  const resetSec = Math.max(1, Math.ceil((e.expires - now) / 1000));
  if (e.count > limit) return { allowed: false, remaining: 0, resetSec };
  return { allowed: true, remaining: limit - e.count, resetSec };
}

// ── Upstash REST (fixed window via INCR + EXPIRE) ─────────────────────────────
async function upstash(cmd: (string | number)[]): Promise<unknown> {
  const res = await fetch(`${UP_URL}/${cmd.map((c) => encodeURIComponent(String(c))).join("/")}`, {
    headers: { authorization: `Bearer ${UP_TOKEN}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`upstash ${res.status}`);
  const j = (await res.json()) as { result?: unknown };
  return j.result;
}

async function redisLimit(key: string, limit: number, windowSec: number): Promise<Decision> {
  const count = Number(await upstash(["INCR", key]));
  if (count === 1) await upstash(["EXPIRE", key, windowSec]);
  let resetSec = windowSec;
  const ttl = Number(await upstash(["TTL", key]));
  if (ttl > 0) resetSec = ttl;
  if (count > limit) return { allowed: false, remaining: 0, resetSec };
  return { allowed: true, remaining: Math.max(0, limit - count), resetSec };
}

/**
 * Check + increment the counter for `id` under `bucket` (e.g. "suggest:ip" /
 * "suggest:wallet"). Fails OPEN on a limiter backend error — a Redis blip must
 * never take the feature down, and the upstream (Raeto) has its own 120/min cap
 * as the hard backstop.
 */
export async function rateLimit(
  bucket: string,
  id: string,
  limit: number,
  windowSec: number = RATE_LIMIT_WINDOW_SEC,
): Promise<Decision> {
  announceBackendOnce();
  const key = `ai:rl:${bucket}:${id}`;
  if (RATE_LIMIT_DURABLE) {
    try {
      return await redisLimit(key, limit, windowSec);
    } catch {
      return memLimit(key, limit, windowSec); // degrade, don't fail
    }
  }
  return memLimit(key, limit, windowSec);
}

/** Best-effort client IP from the proxy headers Vercel sets. */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  return headers.get("x-real-ip") ?? "unknown";
}
