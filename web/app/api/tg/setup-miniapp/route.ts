import { NextResponse } from "next/server";
import { TG, botConfigured } from "@/lib/tg/config";

// Sets @BallasteredBot's menu button to OPEN the launch Mini App. Call once (or
// whenever the URL changes) with the same CRON_SECRET bearer the other tg routes
// use. This only configures the bot's UI entry point — the launch itself is signed
// in the user's own wallet inside the Mini App, so no keys are ever involved here.
//
//   curl -X POST .../api/tg/setup-miniapp -H "authorization: Bearer $CRON_SECRET"
//
// Inert unless NEXT_PUBLIC_TG_MINIAPP is "true" (Web App registered in BotFather).
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://www.ballasted.fun").replace(/\/$/, "");
const MINIAPP_URL = `${APP_URL}/app/tg-launch`;

function authed(req: Request): boolean {
  if (!TG.cronSecret) return false;
  const h = req.headers;
  const bearer = h.get("authorization");
  if (bearer && bearer === `Bearer ${TG.cronSecret}`) return true;
  return h.get("x-cron-secret") === TG.cronSecret;
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (process.env.NEXT_PUBLIC_TG_MINIAPP !== "true") {
    return NextResponse.json({ skipped: "NEXT_PUBLIC_TG_MINIAPP is not 'true'" });
  }
  if (!botConfigured() || !TG.botToken) {
    return NextResponse.json({ skipped: "bot not configured (token/chat)" });
  }

  const res = await fetch(`https://api.telegram.org/bot${TG.botToken}/setChatMenuButton`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      menu_button: { type: "web_app", text: "Launch", web_app: { url: MINIAPP_URL } },
    }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    return NextResponse.json(
      { error: "telegram setChatMenuButton failed", status: res.status, body },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, menuButtonUrl: MINIAPP_URL, result: body });
}
