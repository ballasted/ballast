"use client";

import { useEffect, useRef, useState } from "react";

// Typing for the Telegram Mini App ("Web App") runtime that telegram-web-app.js
// injects at window.Telegram.WebApp. We only type the parts we touch; the full
// surface is much larger (see core.telegram.org/bots/webapps). Everything here is
// OPTIONAL because older Telegram clients ship older SDKs — a missing method must
// degrade, never throw (the launch form still works without the chrome tweaks).
type TgThemeParams = {
  bg_color?: string;
  secondary_bg_color?: string;
  text_color?: string;
  hint_color?: string;
  button_color?: string;
  button_text_color?: string;
  [k: string]: string | undefined;
};

type TgMainButton = {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  setText: (text: string) => TgMainButton;
  onClick: (cb: () => void) => TgMainButton;
  offClick: (cb: () => void) => TgMainButton;
  show: () => TgMainButton;
  hide: () => TgMainButton;
  enable: () => TgMainButton;
  disable: () => TgMainButton;
  showProgress: (leaveActive?: boolean) => TgMainButton;
  hideProgress: () => TgMainButton;
  setParams: (params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
  }) => TgMainButton;
};

type TgBackButton = {
  isVisible: boolean;
  onClick: (cb: () => void) => TgBackButton;
  offClick: (cb: () => void) => TgBackButton;
  show: () => TgBackButton;
  hide: () => TgBackButton;
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
  isExpanded?: boolean;
  viewportHeight?: number;
  viewportStableHeight?: number;
  MainButton?: TgMainButton;
  BackButton?: TgBackButton;
  onEvent?: (event: string, cb: () => void) => void;
  offEvent?: (event: string, cb: () => void) => void;
  openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
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

// The app's own ground colour (tailwind.config.ts `bg`). We paint Telegram's
// header + background this colour so the native chrome matches the dark app and
// there's no white flash around the webview on open.
const APP_BG = "#050A06";

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

/**
 * Full chrome setup for the Mini App shell: ready + expand, paint the native
 * header/background to match the dark app, track the stable viewport height into a
 * CSS var (`--tg-viewport-stable-height`) so fixed elements can respect it, and
 * expose the live themeParams. Re-applies on viewportChanged / themeChanged. SSR
 * safe (no window access on the server); outside Telegram it reports inTelegram
 * false and the page falls back to its normal web layout.
 */
export function useTelegramChrome(): {
  inTelegram: boolean;
  username?: string;
  stableHeight?: number;
  themeParams?: TgThemeParams;
} {
  const [state, setState] = useState<{
    inTelegram: boolean;
    username?: string;
    stableHeight?: number;
    themeParams?: TgThemeParams;
  }>({ inTelegram: false });

  useEffect(() => {
    const wa = getTelegramWebApp();
    if (!wa) {
      setState({ inTelegram: false });
      return;
    }
    try {
      wa.ready();
      wa.expand();
      wa.setHeaderColor?.(APP_BG);
      wa.setBackgroundColor?.(APP_BG);
    } catch {
      /* non-fatal */
    }

    const apply = () => {
      const h = wa.viewportStableHeight;
      if (typeof h === "number" && typeof document !== "undefined") {
        document.documentElement.style.setProperty("--tg-viewport-stable-height", `${h}px`);
      }
      setState({
        inTelegram: true,
        username: wa.initDataUnsafe?.user?.username,
        stableHeight: wa.viewportStableHeight,
        themeParams: wa.themeParams,
      });
    };
    apply();
    wa.onEvent?.("viewportChanged", apply);
    wa.onEvent?.("themeChanged", apply);
    return () => {
      wa.offEvent?.("viewportChanged", apply);
      wa.offEvent?.("themeChanged", apply);
    };
  }, []);

  return state;
}

/**
 * Drive Telegram's native MainButton (the system button pinned at the bottom of
 * the webview, below the safe area — it never overlaps in-page content). The
 * latest onClick is held in a ref so toggling form validity doesn't detach the
 * handler. No-op outside Telegram / on an older client with no MainButton. The
 * button is hidden + its handler removed on unmount, so leaving the form (launch
 * progress, success) clears it.
 */
export function useTelegramMainButton(opts: {
  text: string;
  visible: boolean;
  enabled: boolean;
  onClick?: () => void;
  progress?: boolean;
  /** Button fill; defaults to the brand green. */
  color?: string;
  /** Button label colour; defaults to the dark ground so it matches .btn-primary. */
  textColor?: string;
}): void {
  const { text, visible, enabled, onClick, progress, color = "#22C93A", textColor = APP_BG } = opts;
  const cbRef = useRef<(() => void) | undefined>(onClick);
  cbRef.current = onClick;

  // Attach the click handler once; keep it stable via the ref.
  useEffect(() => {
    const mb = getTelegramWebApp()?.MainButton;
    if (!mb) return;
    const handler = () => cbRef.current?.();
    mb.onClick(handler);
    return () => {
      try {
        mb.offClick(handler);
        mb.hideProgress();
        mb.hide();
      } catch {
        /* non-fatal */
      }
    };
  }, []);

  // Sync text / colour / active / visible / progress on every relevant change.
  useEffect(() => {
    const mb = getTelegramWebApp()?.MainButton;
    if (!mb) return;
    try {
      mb.setParams({ text, color, text_color: textColor, is_active: enabled, is_visible: visible });
      if (progress) mb.showProgress(true);
      else mb.hideProgress();
    } catch {
      /* non-fatal */
    }
  }, [text, visible, enabled, progress, color, textColor]);
}

/**
 * Drive Telegram's native BackButton. Show it on an inner step (an open modal /
 * sheet) with an onClick that steps back or closes; hide it at the root. No-op
 * outside Telegram; hidden on unmount.
 */
export function useTelegramBackButton(opts: { visible: boolean; onClick?: () => void }): void {
  const { visible, onClick } = opts;
  const cbRef = useRef<(() => void) | undefined>(onClick);
  cbRef.current = onClick;

  useEffect(() => {
    const bb = getTelegramWebApp()?.BackButton;
    if (!bb) return;
    const handler = () => cbRef.current?.();
    bb.onClick(handler);
    return () => {
      try {
        bb.offClick(handler);
        bb.hide();
      } catch {
        /* non-fatal */
      }
    };
  }, []);

  useEffect(() => {
    const bb = getTelegramWebApp()?.BackButton;
    if (!bb) return;
    try {
      if (visible) bb.show();
      else bb.hide();
    } catch {
      /* non-fatal */
    }
  }, [visible]);
}

/**
 * Open an external URL from inside the Telegram webview. Telegram blocks some
 * window.open popups, so wallet/external links should route through
 * WebApp.openLink when available; falls back to window.open outside Telegram.
 */
export function openExternalLink(url: string): void {
  const wa = getTelegramWebApp();
  if (wa?.openLink) {
    wa.openLink(url);
    return;
  }
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
}
