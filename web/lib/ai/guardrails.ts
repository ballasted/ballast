// Copy + brand guardrails for AI-generated text. Pure and dependency-light so it
// can run inside the API routes AND be unit-tested without a network or a DOM.
//
// Two jobs:
//   1. Enforce CLAUDE.md's hard copy rules (rule 1 + the spec's extra bans) as a
//      POST-filter on model output. The system prompt asks the model to obey them;
//      this is the backstop that assumes it sometimes won't.
//   2. Block names/tickers that impersonate a real company, one of our listed
//      stock tickers, or a crypto major — the exact "deceptive content" risk the
//      project already guards against elsewhere.

import { GREEN_TICKERS } from "@/lib/pairingAssets";

// ── Banned words ────────────────────────────────────────────────────────────
// CLAUDE.md rule 1: floor, guaranteed, protected, secured, safe, yield, insured,
// returns. Plus the spec's additions: passive income, dividend, APR, APY.
// Matched case-insensitively on word boundaries so "safely" / "returning" are
// caught but "safeguard"-free substrings inside unrelated words are not (the list
// is intentionally aggressive — a false reject just regenerates).
export const BANNED_WORDS: string[] = [
  "floor",
  "guarantee",
  "guaranteed",
  "protected",
  "protect",
  "secured",
  "safe",
  "safely",
  "safety",
  "yield",
  "yields",
  "insured",
  "insure",
  "insurance",
  "returns",
  "passive income",
  "dividend",
  "dividends",
  "apr",
  "apy",
  "risk-free",
  "riskless",
];

// Obvious price-prediction / hype shapes. These are phrases, not single words, so
// they get their own regexes. We can't catch every prediction, but we catch the
// blatant ones the system prompt also forbids.
const PREDICTION_PATTERNS: RegExp[] = [
  /\bto the moon\b/i,
  /\b\d+\s*x\b/i, // "100x", "10 x"
  /\bwill (?:reach|hit|moon|pump|double|triple|skyrocket|explode)\b/i,
  /\bguaranteed\s+(?:returns?|profit|gains?)\b/i,
  /\bprice\s+(?:prediction|target)\b/i,
  /\bnext\s+(?:bitcoin|ethereum|100x|1000x)\b/i,
];

function wordRegex(word: string): RegExp {
  // Escape, then wrap in boundaries. For multi-word phrases, \b on each end.
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${esc}\\b`, "i");
}

const BANNED_REGEXES = BANNED_WORDS.map(wordRegex);

/** Every banned token found in `text` (deduped, lowercased). Empty = clean. */
export function findBannedWords(text: string): string[] {
  if (!text) return [];
  const hits = new Set<string>();
  for (let i = 0; i < BANNED_REGEXES.length; i++) {
    const re = BANNED_REGEXES[i];
    const word = BANNED_WORDS[i];
    if (re && word && re.test(text)) hits.add(word.toLowerCase());
  }
  for (const re of PREDICTION_PATTERNS) {
    const m = text.match(re);
    if (m) hits.add(m[0].toLowerCase().trim());
  }
  return [...hits];
}

export function hasBannedContent(text: string): boolean {
  return findBannedWords(text).length > 0;
}

// ── Brand / ticker blocklist ────────────────────────────────────────────────
// Our own listed stock tickers (anti-impersonation) plus crypto majors and the
// real companies behind the tokenized equities. A suggested ticker or name that
// collides with any of these is rejected.
const CRYPTO_TICKERS = ["BTC", "ETH", "WETH", "USDC", "USDT", "USDG", "SOL", "BNB", "XRP", "DOGE", "ADA"];

export const BLOCKED_TICKERS: Set<string> = new Set<string>(
  [...GREEN_TICKERS, ...CRYPTO_TICKERS].map((t) => t.toUpperCase()),
);

// Real brand / company names (lowercased). The tokenized equities on this chain
// plus the obvious mega-caps and crypto brands. Substring match on word tokens so
// "Apple Finance" is caught but we don't over-match tiny fragments.
export const BLOCKED_BRANDS: string[] = [
  "apple",
  "tesla",
  "nvidia",
  "microsoft",
  "google",
  "alphabet",
  "amazon",
  "meta",
  "facebook",
  "coinbase",
  "palantir",
  "oracle",
  "microstrategy",
  "circle",
  "robinhood",
  "bitcoin",
  "ethereum",
  "solana",
  "binance",
  "ripple",
  "dogecoin",
  "cardano",
  "nasdaq",
  "s&p",
  "sp500",
  "spdr",
  "vanguard",
  "blackrock",
  "ishares",
];

export function isBlockedTicker(ticker: string): boolean {
  return BLOCKED_TICKERS.has(ticker.trim().toUpperCase());
}

/** True if a proposed NAME collides with a known brand. Tokenizes on non-letters
 *  so "Apple-Index" and "apple index" both trip "apple". */
export function isBlockedName(name: string): boolean {
  const lower = name.toLowerCase();
  const tokens = new Set(lower.split(/[^a-z0-9&]+/).filter(Boolean));
  for (const brand of BLOCKED_BRANDS) {
    if (brand.includes(" ")) {
      if (lower.includes(brand)) return true;
    } else if (tokens.has(brand)) {
      return true;
    }
  }
  return false;
}

// ── Validation of model output ──────────────────────────────────────────────
export type FeeSplitBpsSuggestion = {
  creatorBps: number;
  treasuryBps: number;
  buybackBps: number;
  rewardsBps: number;
};

export type SuggestionShape = {
  names: string[];
  tickers: string[];
  description: string;
  pairingSuggestion?: string;
  treasuryPreset?: string;
  noticeDays?: 7 | 30 | 90;
  feeSplitSuggestion?: string;
  feeSplitBps?: FeeSplitBpsSuggestion;
  reasoning?: string;
};

// Validate the optional structured hints that back the one-click "Apply" buttons.
// They are advisory, so anything malformed is simply dropped (undefined) rather
// than failing the whole suggestion — the text fields still render.
function parseNoticeDays(v: unknown): 7 | 30 | 90 | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return n === 7 || n === 30 || n === 90 ? n : undefined;
}

function parseFeeSplitBps(v: unknown): FeeSplitBpsSuggestion | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const read = (k: string): number | null => {
    const n = typeof o[k] === "number" ? (o[k] as number) : typeof o[k] === "string" ? parseInt(o[k] as string, 10) : NaN;
    return Number.isInteger(n) && n >= 0 && n <= 10000 ? n : null;
  };
  const creatorBps = read("creatorBps");
  const treasuryBps = read("treasuryBps");
  const buybackBps = read("buybackBps");
  const rewardsBps = read("rewardsBps");
  if (creatorBps === null || treasuryBps === null || buybackBps === null || rewardsBps === null) return undefined;
  // Must sum to exactly 10000 — a split that doesn't would mis-apply on the form.
  if (creatorBps + treasuryBps + buybackBps + rewardsBps !== 10000) return undefined;
  return { creatorBps, treasuryBps, buybackBps, rewardsBps };
}

export type FilterResult =
  | { ok: true; value: SuggestionShape }
  | { ok: false; violations: string[] };

/**
 * Validate + lightly repair a raw suggestion object. Rejects (so the route can
 * regenerate once) when any free-text field carries banned copy. For the
 * name/ticker LISTS it drops the offending entries rather than failing the whole
 * batch — but if fewer than one clean name or ticker survives, that's a reject.
 */
export function filterSuggestion(raw: unknown): FilterResult {
  const violations: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, violations: ["not-an-object"] };
  const o = raw as Record<string, unknown>;

  const asArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()) : [];

  const rawNames = asArr(o.names);
  const rawTickers = asArr(o.tickers);
  const description = typeof o.description === "string" ? o.description.trim() : "";
  const pairingSuggestion = typeof o.pairingSuggestion === "string" ? o.pairingSuggestion.trim() : undefined;
  const treasuryPreset = typeof o.treasuryPreset === "string" ? o.treasuryPreset.trim() : undefined;
  const feeSplitSuggestion = typeof o.feeSplitSuggestion === "string" ? o.feeSplitSuggestion.trim() : undefined;
  const reasoning = typeof o.reasoning === "string" ? o.reasoning.trim() : undefined;

  // Free-text fields: any banned content fails the batch.
  for (const [label, text] of [
    ["description", description],
    ["pairingSuggestion", pairingSuggestion ?? ""],
    ["treasuryPreset", treasuryPreset ?? ""],
    ["feeSplitSuggestion", feeSplitSuggestion ?? ""],
    ["reasoning", reasoning ?? ""],
  ] as const) {
    const bad = findBannedWords(text);
    if (bad.length) violations.push(`${label}: banned [${bad.join(", ")}]`);
  }
  if (violations.length) return { ok: false, violations };

  // Names: drop brand collisions + banned copy. Keep order, cap at 3.
  const names = rawNames
    .filter((n) => n.length > 0 && n.length <= 32)
    .filter((n) => !isBlockedName(n))
    .filter((n) => !hasBannedContent(n))
    .slice(0, 3);

  // Tickers: 1–10 chars, letters/digits only, not a blocked ticker.
  const tickers = rawTickers
    .map((t) => t.replace(/^\$/, "").toUpperCase())
    .filter((t) => /^[A-Z0-9]{1,10}$/.test(t))
    .filter((t) => !isBlockedTicker(t))
    .slice(0, 3);

  if (names.length === 0) return { ok: false, violations: ["all-names-blocked"] };
  if (tickers.length === 0) return { ok: false, violations: ["all-tickers-blocked"] };
  if (!description) return { ok: false, violations: ["empty-description"] };

  return {
    ok: true,
    value: {
      names,
      tickers,
      description,
      pairingSuggestion,
      treasuryPreset,
      noticeDays: parseNoticeDays(o.noticeDays),
      feeSplitSuggestion,
      feeSplitBps: parseFeeSplitBps(o.feeSplitBps),
      reasoning,
    },
  };
}

/** Summary post-filter: summaries are a single string. Reject on banned content. */
export function isSummaryClean(text: string): boolean {
  return !hasBannedContent(text);
}
