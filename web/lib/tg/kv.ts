import "server-only";
import { DEDUP_TTL_SEC } from "./config";

// Minimal Upstash KV (REST) access for the bot's durable state — the same backend
// the AI rate limiter uses (KV_REST_API_URL / KV_REST_API_TOKEN, or the native
// UPSTASH_REDIS_REST_* names). No new dependency. All helpers fail soft: a KV blip
// must never post a duplicate or crash the poll, but the cursor write is the one
// call the caller must confirm succeeded before trusting a run.

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const KV_CONFIGURED = Boolean(URL_ && TOKEN);

async function cmd(parts: (string | number)[]): Promise<unknown> {
  if (!KV_CONFIGURED) throw new Error("KV not configured");
  // POST the command as a JSON array so values with slashes/spaces are safe.
  const res = await fetch(URL_!, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(parts),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`kv ${res.status}`);
  const j = (await res.json()) as { result?: unknown };
  return j.result;
}

export async function kvGet(key: string): Promise<string | null> {
  const r = (await cmd(["GET", key])) as string | null;
  return r ?? null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  await cmd(["SET", key, value]);
}

/** Set a dedup marker with a TTL. Returns true if it was NEWLY set (first time). */
export async function kvSetDedup(key: string): Promise<boolean> {
  // SET key 1 NX EX <ttl> → "OK" when newly set, null when it already existed.
  const r = await cmd(["SET", key, "1", "NX", "EX", DEDUP_TTL_SEC]);
  return r === "OK";
}

export async function kvHGetAll(key: string): Promise<Record<string, string>> {
  const r = (await cmd(["HGETALL", key])) as string[] | null;
  if (!Array.isArray(r)) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < r.length; i += 2) out[r[i]!] = r[i + 1]!;
  return out;
}

export async function kvHSet(key: string, field: string, value: string): Promise<void> {
  await cmd(["HSET", key, field, value]);
}
