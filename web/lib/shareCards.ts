import type { Address } from "viem";

// Share-card helpers — build the OG card URL and the X (Twitter) intent URL for a
// given on-chain event. Pure + testable. Copy obeys the project rules: no price,
// no "yield/reward/floor/guaranteed/safe", burns are "sent to the dead address",
// and nothing unreleased is described as live.

export type ShareEventType =
  | "launch"
  | "buyback"
  | "burn"
  | "backing"
  | "split"
  | "basket"
  | "vote-winner";

export type ShareCardParams = {
  type: ShareEventType;
  /** $TICKER (without the leading $ is fine — we normalize). */
  ticker?: string;
  /** Big headline value, e.g. "116,669 $BALLAST" or "NVDA". */
  value?: string;
  /** Label under the value, e.g. "sent to the dead address". */
  valueLabel?: string;
  /** Optional second line / context. */
  sub?: string;
  /** Token address — used to link the tweet and to suppress hidden tokens. */
  token?: Address;
};

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://www.ballasted.fun").replace(/\/$/, "");

export function normTicker(t?: string): string | undefined {
  if (!t) return undefined;
  const s = t.trim();
  if (!s) return undefined;
  return s.startsWith("$") ? s : `$${s}`;
}

/** Per-type default headline + value label (used when the caller omits them). */
export function cardDefaults(type: ShareEventType): { emoji: string; headline: string; valueLabel?: string } {
  switch (type) {
    case "launch": return { emoji: "🚀", headline: "New launch on BALLAST" };
    case "buyback": return { emoji: "🔥", headline: "Buyback & burn", valueLabel: "sent to the dead address" };
    case "burn": return { emoji: "🔥", headline: "Tokens burned", valueLabel: "sent to the dead address" };
    case "backing": return { emoji: "⚓", headline: "Backing added" };
    case "split": return { emoji: "⚙️", headline: "Fee split scheduled" };
    case "basket": return { emoji: "🧺", headline: "Treasury basket filled" };
    case "vote-winner": return { emoji: "🗳️", headline: "Community round-up default" };
  }
}

/** The OG card image URL for an event (served by /api/og/event). */
export function buildEventCardUrl(p: ShareCardParams): string {
  const q = new URLSearchParams();
  q.set("type", p.type);
  if (p.ticker) q.set("ticker", normTicker(p.ticker)!);
  if (p.value) q.set("value", p.value);
  if (p.valueLabel) q.set("valueLabel", p.valueLabel);
  if (p.sub) q.set("sub", p.sub);
  if (p.token) q.set("token", p.token);
  return `${APP_URL}/api/og/event?${q.toString()}`;
}

/** The tweet text (no banned terms, no price talk). */
export function buildShareText(p: ShareCardParams): string {
  const tk = normTicker(p.ticker);
  switch (p.type) {
    case "launch": return `${tk ?? "A new token"} just launched on BALLAST.`;
    case "buyback": return `BALLAST buyback & burn: ${p.value ?? "tokens"} sent to the dead address.`;
    case "burn": return `${p.value ?? "Tokens"} sent to the dead address.`;
    case "backing": return `Backing added to ${tk ?? "a"} treasury on BALLAST.`;
    case "split": return `${tk ?? "A token"} scheduled a new fee split on BALLAST.`;
    case "basket": return `${tk ?? "A token"} treasury basket was filled on BALLAST.`;
    case "vote-winner": return `${tk ?? "A community"} picked ${p.value ?? "a stock"} as its round-up default on BALLAST.`;
  }
}

/** The X web-intent URL: prefilled text + the card/page link. */
export function buildXIntentUrl(p: ShareCardParams): string {
  const url = p.token ? `${APP_URL}/app/token/${p.token}` : APP_URL;
  const text = buildShareText(p);
  const q = new URLSearchParams({ text, url });
  return `https://twitter.com/intent/tweet?${q.toString()}`;
}
