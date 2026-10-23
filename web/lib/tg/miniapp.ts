"use client";

import { useEffect, useState } from "react";

// Minimal typing for the Telegram Mini App ("Web App") runtime that
// telegram-web-app.js injects at window.Telegram.WebApp. We only touch the parts
// we use; the full surface is much larger.
type TgThemeParams = {
  bg_color?: string;
  text_color?: string;
  button_color?: string;
  [k: string]: string | undefined;
};

export type TelegramWebApp = {
  ready: () => void;
  expand: () => void;
  initData: string;
  initDataUnsafe?: { user?: { id?: number; username?: string } };
  colorScheme?: "light" | "dark";
  themeParams?: TgThemeParams;
  version?: string;
  platform?: string;
  close?: () => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/**
 * Feature flag for the Telegram launch Mini App. OFF unless NEXT_PUBLIC_TG_MINIAPP
 * is exactly "true" — the page and the bot menu button stay inert until the human
 * registers the Web App in BotFather, so nothing is advertised as live before it
 * exists. NON-CUSTODIAL by construction: the launch is signed in the user's own
 * wallet (wagmi), the bot/server never touches a key.
 */
export const TG_MINIAPP_ENABLED = process.env.NEXT_PUBLIC_TG_MINIAPP === "true";

/** The Mini App route, relative to the app origin. The BotFather Web App URL is
 *  `<origin>${TG_MINIAPP_PATH}` (e.g. https://www.ballasted.fun/app/tg-launch). */
export const TG_MINIAPP_PATH = "/app/tg-launch";

export function getTelegramWebApp(): TelegramWebApp | undefined {
  if (typeof window === "undefined") return undefined;
  return window.Telegram?.WebApp;
}

/**
 * Initialise the Telegram Web App (ready + expand) and report context. Safe to
 * call outside Telegram: `inTelegram` is false and the page just renders as a
 * normal web page, so the same route works in a browser for testing.
 */
export function useTelegramWebApp(): { inTelegram: boolean; username?: string; ready: boolean } {
  const [state, setState] = useState<{ inTelegram: boolean; username?: string; ready: boolean }>({
    inTelegram: false,
    ready: false,
  });

  useEffect(() => {
    const wa = getTelegramWebApp();
    if (!wa) {
      setState({ inTelegram: false, ready: true });
      return;
    }
    try {
      wa.ready();
      wa.expand();
    } catch {
      /* non-fatal — the launch form still works without the chrome tweaks */
    }
    setState({ inTelegram: true, username: wa.initDataUnsafe?.user?.username, ready: true });
  }, []);

  return state;
}
