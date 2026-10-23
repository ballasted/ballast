import "server-only";
import { TG } from "./config";
import { kvGet, kvSet, KV_CONFIGURED } from "./kv";

// Telegram Bot API senders (HTML parse mode, link previews OFF). On TG_DRY_RUN
// they log instead of sending, so a poll can be exercised against real blocks
// without posting. The bot token is read by name only, never logged. All request
// bodies are UTF-8 JSON (never a raw multipart upload) — Telegram fetches the
// animation by its public https URL the first time, which keeps the body JSON.

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://www.ballasted.fun").replace(/\/$/, "");
const API = (method: string) => `https://api.telegram.org/bot${TG.botToken}/${method}`;

/** Telegram caption hard limit. Our messages are far shorter; this only guards a
 *  pathological case and trims on a space so it can't slice through an HTML tag. */
const CAPTION_MAX = 1024;
function clampCaption(html: string): string {
  if (html.length <= CAPTION_MAX) return html;
  const cut = html.slice(0, CAPTION_MAX - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
}

export async function sendMessage(html: string): Promise<{ sent: boolean; dryRun: boolean }> {
  if (TG.dryRun) {
    console.info("[tg:dry-run]\n" + html);
    return { sent: false, dryRun: true };
  }
  if (!TG.botToken || !TG.chatId) return { sent: false, dryRun: false };
  const res = await fetch(API("sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
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

/**
 * Edit an existing message's text — used to fix/maintain the group's PINNED
 * message. The "?"-instead-of-the-anchor bug came from editing that message with
 * a body that wasn't UTF-8, so Telegram received replacement bytes for the
 * multibyte character (e.g. the ⚓ anchor). The `charset=utf-8` content-type +
 * `JSON.stringify` here are the fix and are load-bearing — same encoding as
 * sendMessage, never a raw/latin-1 body.
 */
export async function editMessageText(
  messageId: number,
  html: string,
): Promise<{ edited: boolean; dryRun: boolean }> {
  if (TG.dryRun) {
    console.info(`[tg:dry-run] editMessageText #${messageId}\n` + html);
    return { edited: false, dryRun: true };
  }
  if (!TG.botToken || !TG.chatId) return { edited: false, dryRun: false };
  const res = await fetch(API("editMessageText"), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      chat_id: TG.chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telegram editMessageText ${res.status} ${body.slice(0, 200)}`);
  }
  return { edited: true, dryRun: false };
}

/** Post a message and return its message_id (needed to pin / later edit it). */
export async function sendMessageReturningId(
  html: string,
): Promise<{ messageId?: number; dryRun: boolean }> {
  if (TG.dryRun) {
    console.info("[tg:dry-run] sendMessage (for pin)\n" + html);
    return { dryRun: true };
  }
  if (!TG.botToken || !TG.chatId) return { dryRun: false };
  const res = await fetch(API("sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id: TG.chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telegram sendMessage ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { result?: { message_id?: number } };
  return { messageId: data.result?.message_id, dryRun: false };
}

/** Pin a message in the chat (silent — no "pinned a message" notification spam). */
export async function pinChatMessage(messageId: number): Promise<{ pinned: boolean; dryRun: boolean }> {
  if (TG.dryRun) {
    console.info(`[tg:dry-run] pinChatMessage #${messageId}`);
    return { pinned: false, dryRun: true };
  }
  if (!TG.botToken || !TG.chatId) return { pinned: false, dryRun: false };
  const res = await fetch(API("pinChatMessage"), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id: TG.chatId, message_id: messageId, disable_notification: true }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`telegram pinChatMessage ${res.status} ${body.slice(0, 200)}`);
  }
  return { pinned: true, dryRun: false };
}

// The four animation kinds and their files under /public/tg. Buyback-and-burn and
// manual burns both reuse the burn clip; new launches use launch; buys/sells use
// their own. (Split changes and digests stay text-only — no entry here.)
export type AnimKind = "buy" | "sell" | "launch" | "burn";
const ANIM_FILE: Record<AnimKind, string> = {
  buy: "tg_alert_buy.mp4",
  sell: "tg_alert_sell.mp4",
  launch: "tg_alert_launch.mp4",
  burn: "tg_alert_burn.mp4",
};
const animKvKey = (kind: AnimKind) => `tg:anim:${kind}`;
const animUrl = (kind: AnimKind) => `${APP_URL}/tg/${ANIM_FILE[kind]}`;

async function postAnimation(animation: string, caption: string): Promise<Response> {
  return fetch(API("sendAnimation"), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      chat_id: TG.chatId,
      animation, // a cached file_id, or the public https URL on first send
      caption,
      parse_mode: "HTML",
    }),
    cache: "no-store",
  });
}

/**
 * Send an animated alert: the mp4 (as `animation`) with the message text as its
 * HTML caption. The file is uploaded to Telegram exactly ONCE (by public URL);
 * the returned `file_id` is cached in KV (tg:anim:<kind>) and reused on every
 * later send so we never re-upload. Falls back to the URL if a cached id has gone
 * stale. Falls back to a plain text message if sending the animation fails, so an
 * alert is never silently dropped.
 */
export async function sendAnimation(kind: AnimKind, html: string): Promise<{ sent: boolean; dryRun: boolean }> {
  const caption = clampCaption(html);
  if (TG.dryRun) {
    console.info(`[tg:dry-run] animation=${kind}\n` + html);
    return { sent: false, dryRun: true };
  }
  if (!TG.botToken || !TG.chatId) return { sent: false, dryRun: false };

  const cachedId = KV_CONFIGURED ? await kvGet(animKvKey(kind)).catch(() => null) : null;
  let res = await postAnimation(cachedId ?? animUrl(kind), caption);
  // A cached file_id can be rejected (expired / wrong bot) — retry from the URL.
  if (!res.ok && cachedId) res = await postAnimation(animUrl(kind), caption);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[tg] sendAnimation ${kind} failed ${res.status} ${body.slice(0, 160)} — falling back to text`);
    return sendMessage(html);
  }

  // Cache the file_id from the first successful (URL) upload so we stop re-fetching.
  if (!cachedId && KV_CONFIGURED) {
    try {
      const data = (await res.clone().json()) as { result?: { animation?: { file_id?: string }; document?: { file_id?: string } } };
      const fileId = data.result?.animation?.file_id ?? data.result?.document?.file_id;
      if (fileId) await kvSet(animKvKey(kind), fileId);
    } catch {
      /* non-fatal: we just upload by URL again next time */
    }
  }
  return { sent: true, dryRun: false };
}
