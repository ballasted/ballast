import "server-only";

// Telegram notification bot config. Everything is env-driven; the bot is OFF
// unless TG_BOT_ENABLED is truthy AND a token + chat id are set, so a half-set
// env never posts. Secrets (TELEGRAM_BOT_TOKEN) are read by name only, never
// logged. See docs/TG_BOT.md for setup.

function envFloat(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

export const TG = {
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  enabled: /^(1|true|yes)$/i.test(process.env.TG_BOT_ENABLED ?? ""),
  dryRun: /^(1|true|yes)$/i.test(process.env.TG_DRY_RUN ?? ""),
  cronSecret: process.env.CRON_SECRET,
  /** Minimum swap size (in ETH) to post. Default 0.01. */
  minSwapEth: envFloat("TG_MIN_SWAP_ETH", 0.01),
  /** Minimum manual $BALLAST burn (whole tokens) to post. Default 100,000. */
  minBurn: envFloat("TG_MIN_BURN", 100_000),
} as const;

/** Hard caps (CLAUDE.md chain gotchas: batch reads, bound work per run). */
export const MAX_BLOCKS_PER_RUN = 2000n;
export const MAX_MESSAGES_PER_RUN = 15;
/** Dedup + cursor keys live in the existing Upstash KV. */
export const KV_CURSOR_KEY = "tg:lastBlock";
export const KV_POOLMAP_KEY = "tg:pools"; // hash: poolId -> "token|quoteAsset"
export const DEDUP_TTL_SEC = 7 * 24 * 60 * 60;

export function botConfigured(): boolean {
  return TG.enabled && Boolean(TG.botToken && TG.chatId);
}
