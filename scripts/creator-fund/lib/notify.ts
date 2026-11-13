// Optional Telegram alert when a token qualifies. Behind CREATOR_FUND_TG_ENABLED
// ("true") AND requiring TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (the existing alert
// bot's channel). Honors TG_DRY_RUN. The bot token is read by name and never logged.
//
// Posts once per token (dedup is handled by the caller via scan state). Message is
// deliberately plain and compliant: "pending review", no prize/claim framing.

const API = "https://api.telegram.org";

export function tgEnabled(): boolean {
  return (
    process.env.CREATOR_FUND_TG_ENABLED === "true" &&
    !!process.env.TELEGRAM_BOT_TOKEN &&
    !!process.env.TELEGRAM_CHAT_ID
  );
}

/** Post a "<TOKEN> just qualified …" message. Returns true if sent (or dry-run). */
export async function notifyQualified(symbolOrName: string): Promise<boolean> {
  if (!tgEnabled()) return false;
  const text = `${symbolOrName} just qualified for the Ballast Creator Fund, pending review.`;
  if (process.env.TG_DRY_RUN === "true") {
    console.log(`[tg dry-run] ${text}`);
    return true;
  }
  try {
    const res = await fetch(`${API}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
