import { NextResponse } from "next/server";
import { TG, botConfigured } from "@/lib/tg/config";
import { editMessageText, sendMessageReturningId, pinChatMessage } from "@/lib/tg/telegram";

// Authed admin route to SET or FIX the group's pinned message with a proper
// UTF-8 body (the "?"-instead-of-anchor bug was a non-UTF-8 edit). Not a cron —
// the human calls it by hand when the pinned text changes. Auth is the same
// CRON_SECRET bearer/x-cron-secret the poll route uses.
//
//   First time (post + pin, returns the message_id to keep):
//     curl -X POST .../api/tg/pin -H "authorization: Bearer $CRON_SECRET" \
//          -H "content-type: application/json" \
//          --data '{"text":"<b>Ballast</b> ⚓ ...","pin":true}'
//   Later (fix the SAME pinned message, no "?"):
//     curl ... --data '{"text":"<b>Ballast</b> ⚓ ...","message_id":1234}'
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function authed(req: Request): boolean {
  if (!TG.cronSecret) return false;
  const h = req.headers;
  const bearer = h.get("authorization");
  if (bearer && bearer === `Bearer ${TG.cronSecret}`) return true;
  return h.get("x-cron-secret") === TG.cronSecret;
}

export async function POST(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!TG.dryRun && !botConfigured()) {
    return NextResponse.json({ skipped: "bot not configured (token/chat)" });
  }

  let body: { text?: unknown; message_id?: unknown; pin?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });

  try {
    // Edit an existing pinned message (the fix path).
    if (typeof body.message_id === "number") {
      const r = await editMessageText(body.message_id, text);
      return NextResponse.json({ action: "edit", messageId: body.message_id, ...r });
    }
    // Otherwise post a new message and (by default) pin it, returning its id so
    // the caller can store it and edit the SAME message next time.
    const sent = await sendMessageReturningId(text);
    const shouldPin = body.pin !== false;
    let pinned: { pinned: boolean; dryRun: boolean } | undefined;
    if (shouldPin && sent.messageId !== undefined) {
      pinned = await pinChatMessage(sent.messageId);
    }
    return NextResponse.json({ action: "post", messageId: sent.messageId, dryRun: sent.dryRun, pinned });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
