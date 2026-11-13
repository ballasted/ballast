import "server-only";
import { profile } from "@/lib/chainProfile";

// Telegram notification bot config. Everything is env-driven; the bot is OFF
// unless TG_BOT_ENABLED is truthy AND a token + chat id are set, so a half-set
// env never posts. Secrets (TELEGRAM_BOT_TOKEN) are read by name only, never
// logged. See docs/TG_BOT.md for setup.

function envFloat(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function envBool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return /^(1|true|yes)$/i.test(v);
}

// $BALLAST v2 — another buy bot already posts its buys in the group, so by
// default we skip posting buys for it here (launches, buybacks, burns and split
// changes still post). Kept in sync with contracts.ts BALLAST_V2_TOKEN_ADDRESS.
const BALLAST_V2 = "0xDc605041F02e41CbD8FDC347023e93C4c3fA243C";

export const TG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  enabled: /^(1|true|yes)$/i.test(process.env.TG_BOT_ENABLED ?? ""),
  dryRun: /^(1|true|yes)$/i.test(process.env.TG_DRY_RUN ?? ""),
  cronSecret: process.env.CRON_SECRET,
  /** Minimum swap size (in ETH) to post. Default 0.01 (production: 0.005). */
  minSwapEth: envFloat("TG_MIN_SWAP_ETH", 0.01),
  /** Minimum swap size (in HYPE) to post on Elysium gen-5. Default 0.01 (same
   *  shape as the ETH threshold; HYPE is the native/quote unit there). */
  minSwapHype: envFloat("TG_MIN_SWAP_HYPE", 0.01),
  /** Minimum manual $BALLAST burn (whole tokens) to post. Default 100,000. */
  minBurn: envFloat("TG_MIN_BURN", 100_000),
  /** Post sells at all? Default false — sells are noise in the group. */
  postSells: envBool("TG_POST_SELLS", false),
  /** Tokens whose BUYS are not posted (already covered by another bot). Buys only
   *  — launches/buybacks/burns/splits for these still post. Comma-separated env;
   *  defaults to the $BALLAST v2 address. */
  skipTokens: (process.env.TG_SKIP_TOKENS ?? BALLAST_V2)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
} as const;

/** Hard caps (CLAUDE.md chain gotchas: batch reads, bound work per run). */
export const MAX_BLOCKS_PER_RUN = 2000n;
export const MAX_MESSAGES_PER_RUN = 15;
/** Dedup + cursor keys live in the existing Upstash KV. */
export const KV_CURSOR_KEY = "tg:lastBlock";
export const KV_POOLMAP_KEY = "tg:pools"; // hash: poolId -> "token|quoteAsset"
export const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

// The app ships as TWO Vercel deployments of one codebase (NEXT_PUBLIC_CHAIN=
// robinhood | elysium). They may share ONE Upstash KV, so each chain MUST own its
// own cursor + pool-map keys or the two deployments would clobber each other's
// progress. Keys are namespaced by profile.key: Robinhood keeps the original
// "tg:*" keys (no migration); Elysium gets "tg:ely:*".
export const KV_CURSOR_KEY_ELY = "tg:ely:lastBlock";
export const KV_POOLMAP_KEY_ELY = "tg:ely:pools"; // hash: poolId -> "token|quoteAsset"

/** The cursor / pool-map keys for THIS deployment's active chain. */
export const CHAIN_KV_CURSOR_KEY = profile.key === "elysium" ? KV_CURSOR_KEY_ELY : KV_CURSOR_KEY;
export const CHAIN_KV_POOLMAP_KEY = profile.key === "elysium" ? KV_POOLMAP_KEY_ELY : KV_POOLMAP_KEY;

export function botConfigured(): boolean {
  return TG.enabled && Boolean(TG.botToken && TG.chatId);
}
