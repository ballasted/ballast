"use client";

import Script from "next/script";
import { CreateFlow } from "@/components/app/create/CreateFlow";
import { TG_MINIAPP_ENABLED, useTelegramWebApp } from "@/lib/tg/miniapp";

// Telegram launch Mini App (non-custodial). Opened from @BallasteredBot's menu
// button as a Web App; the user connects and SIGNS the launch in their own wallet
// (the CreateFlow below is the exact same wagmi flow as /app/create) — the bot and
// our server never hold keys or funds. After the launch lands on-chain, the
// existing activity bot (/api/tg/poll) posts the token card in the group from the
// Launched event, so no extra posting path is needed here.
//
// Gated behind NEXT_PUBLIC_TG_MINIAPP — inert until the human registers this URL
// as the Web App in BotFather. The route also works in a plain browser for
// testing (useTelegramWebApp just reports inTelegram=false).
export default function TgLaunchPage() {
  useTelegramWebApp();

  return (
    <>
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" />
      <div className="space-y-5">
        <header className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-bone">Launch on Ballast</h1>
          <p className="text-sm text-text-muted">
            Your wallet signs the launch. Ballast and the bot never hold your keys or funds.
          </p>
        </header>

        {TG_MINIAPP_ENABLED ? (
          <CreateFlow />
        ) : (
          <div className="note note-neutral">
            The Telegram launch Mini App is not enabled yet.
          </div>
        )}
      </div>
    </>
  );
}
