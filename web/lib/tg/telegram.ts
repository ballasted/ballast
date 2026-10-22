import "server-only";
import { TG } from "./config";

// Telegram Bot API sendMessage (HTML parse mode, link previews OFF). On TG_DRY_RUN
// it logs the message instead of sending, so a poll can be exercised against real
// blocks without posting. The bot token is read by name only, never logged.

export async function sendMessage(html: string): Promise<{ sent: boolean; dryRun: boolean }> {
  if (TG.dryRun) {
    console.info("[tg:dry-run]\n" + html);
    return { sent: false, dryRun: true };
  }
  if (!TG.botToken || !TG.chatId) return { sent: false, dryRun: false };
  const res = await fetch(`https://api.telegram.org/bot${TG.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG.chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telegram ${res.status} ${body.slice(0, 200)}`);
  }
  return { sent: true, dryRun: false };
}
