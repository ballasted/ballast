"use client";

import Script from "next/script";
import { CreateFlow } from "@/components/app/create/CreateFlow";
import { TG_MINIAPP_ENABLED, useTelegramChrome } from "@/lib/tg/miniapp";

// Readability + safe-area rules, scoped to the Mini App wrapper only (never leaks
// to the desktop/mobile app). The Telegram webview on a phone renders the shared
// CreateFlow, which uses dense 12px helper text and some 10/11px labels that are
// unreadable on-device — bump the smallest text to >=14px here. Inputs go to 16px
// so iOS Safari doesn't zoom-on-focus (which breaks the layout). Buttons get a
// 44px minimum tap target. None of this touches the app outside tg-launch.
const TG_READABILITY_CSS = `
.tg-miniapp-scope { font-size: 15px; }
.tg-miniapp-scope .text-xs,
.tg-miniapp-scope .text-\\[10px\\],
.tg-miniapp-scope .text-\\[11px\\] { font-size: 14px !important; line-height: 1.35 !important; }
.tg-miniapp-scope input,
.tg-miniapp-scope textarea,
.tg-miniapp-scope select { font-size: 16px; }
.tg-miniapp-scope button { min-height: 44px; }
`;

// Telegram launch Mini App (non-custodial). Opened from @BallasteredBot's menu
// button as a Web App; the user connects and SIGNS the launch in their own wallet
// (the CreateFlow below is the exact same wagmi flow as /app/create) — the bot and
// our server never hold keys or funds. After the launch lands on-chain, the
// existing activity bot (/api/tg/poll) posts the token card in the group from the
// Launched event, so no extra posting path is needed here.
//
// Gated behind NEXT_PUBLIC_TG_MINIAPP — inert until the human registers this URL
// as the Web App in BotFather. The route also works in a plain browser for
// testing (useTelegramChrome just reports inTelegram=false, so CreateFlow renders
// its normal in-page buttons instead of the native Telegram MainButton).
export default function TgLaunchPage() {
  const { inTelegram } = useTelegramChrome();

  return (
    <>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" />
      {/* eslint-disable-next-line react/no-danger */}
      <style dangerouslySetInnerHTML={{ __html: TG_READABILITY_CSS }} />
      <div
        className="tg-miniapp-scope space-y-5 pb-[calc(96px+env(safe-area-inset-bottom))]"
        style={{ minHeight: "var(--tg-viewport-stable-height, auto)" }}
      >
        <header className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Launch on Ballast</h1>
          <p className="text-sm text-text-muted">
            Your wallet signs the launch. Ballast and the bot never hold your keys or funds.
          </p>
        </header>

        {TG_MINIAPP_ENABLED ? (
          <CreateFlow miniApp={inTelegram} />
        ) : (
          <div className="note note-neutral">
            The Telegram launch Mini App is not enabled yet.
          </div>
        )}
      </div>
    </>
  );
}
