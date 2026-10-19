// Copy + brand guardrails for AI-generated text. Pure and dependency-light so it
// can run inside the API routes AND be unit-tested without a network or a DOM.
//
// Jobs:
//   1. Enforce CLAUDE.md's hard copy rules (rule 1) + the product rule that a
//      launch token is a community/meme/project token and must NEVER be framed as
//      an investment product, fund, index, or a thing that represents/tracks/holds
//      assets. The system prompt asks for this; this is the backstop.
//   2. Block names/tickers that impersonate a real company, a listed stock ticker,
//      a crypto major, or that read as a fund/security.
//   3. Keep pairing suggestions to the only real options on our create page
//      (ETH or listed stock tokens) — never USDC/USDT or generic crypto.

import { GREEN_TICKERS } from "@/lib/pairingAssets";

// ── Banned words ────────────────────────────────────────────────────────────
// CLAUDE.md rule 1 + the spec's additions + the investment-framing ban. Matched
// case-insensitively on word boundaries (the list is intentionally aggressive — a
// false reject just regenerates).
export const BANNED_WORDS: string[] = [
  // Rule 1 / safety-framing
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
  // Investment-product framing — a launch token does NOT represent/track/hold assets
  "represents",
  "represent",
  "representing",
  "exposure",
  "diversified",
  "diversify",
  "diversification",
  "portfolio",
  "tracks",
  "tracked",
  "etf",
  "etfs",
  "securities",
];

// Phrase / stem patterns that word-boundary matching alone can't express.
const BANNED_PATTERNS: RegExp[] = [
  // price-prediction / hype
  /\bto the moon\b/i,
  /\b\d+\s*x\b/i,
  /\bwill (?:reach|hit|moon|pump|double|triple|skyrocket|explode)\b/i,
  /\bguaranteed\s+(?:returns?|profit|gains?)\b/i,
  /\bprice\s+(?:prediction|target)\b/i,
  /\bnext\s+(?:bitcoin|ethereum|100x|1000x)\b/i,
  // investment-product framing
  /\binvest(?:s|ed|ing|ment|or|ors)?\b/i,
  /\basset class(?:es)?\b/i,
  /\bindex fund\b/i,
  /\bbacked by real\b/i,
  /\breal[-\s]world asset/i,
  /\bgives?\s+(?:you\s+)?exposure\b/i,
  /\bcollection of (?:tokenized|real)\b/i,
];

function wordRegex(word: string): RegExp {
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
  for (const re of BANNED_PATTERNS) {
    const m = text.match(re);
    if (m) hits.add(m[0].toLowerCase().trim());
  }
  return [...hits];
}

export function hasBannedContent(text: string): boolean {
  return findBannedWords(text).length > 0;
}

// ── Brand / ticker blocklist ────────────────────────────────────────────────
const CRYPTO_TICKERS = ["BTC", "ETH", "WETH", "USDC", "USDT", "USDG", "SOL", "BNB", "XRP", "DOGE", "ADA"];

export const BLOCKED_TICKERS: Set<string> = new Set<string>(
  [...GREEN_TICKERS, ...CRYPTO_TICKERS].map((t) => t.toUpperCase()),
);

export const BLOCKED_BRANDS: string[] = [
  "apple", "tesla", "nvidia", "microsoft", "google", "alphabet", "amazon", "meta",
  "facebook", "coinbase", "palantir", "oracle", "microstrategy", "circle", "robinhood",
  "bitcoin", "ethereum", "solana", "binance", "ripple", "dogecoin", "cardano",
  "nasdaq", "s&p", "sp500", "spdr", "vanguard", "blackrock", "ishares",
];

// Fund / security words that must not appear in a NAME or TICKER — a launch token
// is not a fund. ("index" is handled separately: allowed only if the user typed it.)
const FUND_NAME_WORDS = ["etf", "fund", "trust", "securities", "capital", "holdings", "bank"];
const FUND_NAME_PHRASES = ["treasury bond"];
const FUND_TICKERS = new Set(["ETF", "FUND", "TRUST", "BANK", "BOND", "CAPITAL", "SECURITIES"]);

export function isBlockedTicker(ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  return BLOCKED_TICKERS.has(t) || FUND_TICKERS.has(t);
}

function nameTokens(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean));
}

/** True if a proposed NAME collides with a known brand. */
export function isBlockedName(name: string): boolean {
  const lower = name.toLowerCase();
  const tokens = nameTokens(name);
  for (const brand of BLOCKED_BRANDS) {
    if (brand.includes(" ")) {
      if (lower.includes(brand)) return true;
    } else if (tokens.has(brand)) {
      return true;
    }
  }
  return false;
}

/** True if a NAME reads as a fund/security. `allowIndex` lets "index" through only
 *  when the user themselves used it. */
export function isFundLikeName(name: string, allowIndex: boolean): boolean {
  const lower = name.toLowerCase();
  const tokens = nameTokens(name);
  if (FUND_NAME_WORDS.some((w) => tokens.has(w))) return true;
  if (FUND_NAME_PHRASES.some((p) => lower.includes(p))) return true;
  if (!allowIndex && tokens.has("index")) return true;
  return false;
}

// ── Pairing ──────────────────────────────────────────────────────────────────
// The only real pairing options on the create page: ETH, or a listed stock token.
const ALLOWED_PAIRING = new Set<string>(["ETH", "WETH", "ETHER", ...GREEN_TICKERS].map((t) => t.toUpperCase()));
const DISALLOWED_PAIRING = /\b(usdc|usdt|usdg|dai|tether|usd ?coin|stablecoin|bitcoin|btc|solana|\bsol\b|bnb)\b/i;

/** Keep a pairing suggestion only if it names an allowed asset and no disallowed
 *  one. Returns the cleaned string, or undefined to drop it. */
export function sanitizePairing(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (hasBannedContent(text)) return undefined;
  if (DISALLOWED_PAIRING.test(text)) return undefined;
  const tokens = new Set(text.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
  const mentionsAllowed = [...tokens].some((t) => ALLOWED_PAIRING.has(t));
  return mentionsAllowed ? text : undefined;
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
  if (creatorBps + treasuryBps + buybackBps + rewardsBps !== 10000) return undefined;
  // The TREASURY fee bucket is unsupported on the create page ("soon" in the UI,
  // rejected by the contract). Repair any treasury allocation into buyback & burn
  // so treasury is always 0 and the split still sums to 10000.
  return { creatorBps, treasuryBps: 0, buybackBps: buybackBps + treasuryBps, rewardsBps };
}

/** Canonical plain-English split text derived from the (already repaired) bps, so
 *  the text and the one-click Apply always agree and never mention treasury. */
export function canonicalSplitText(bps: FeeSplitBpsSuggestion): string {
  const pct = (b: number) => Math.round((b / 10000) * 100);
  const parts: string[] = [`creator ${pct(bps.creatorBps)}%`];
  if (bps.buybackBps > 0) parts.push(`buyback & burn ${pct(bps.buybackBps)}%`);
  if (bps.rewardsBps > 0) parts.push(`stakers ${pct(bps.rewardsBps)}%`);
  return parts.join(", ");
}

// ── Treasury preset ────────────────────────────────────────────────────────
// A treasury preset may ONLY name concrete allowlisted backing asset(s) + the
// notice period, or say there is no treasury. It must never describe what the
// treasury is "for" or any plans for the money.
const ALLOWLIST_ASSETS: string[] = [...GREEN_TICKERS]; // SGOV, NVDA, SPY, AAPL, …

function extractAllowlistAssets(text: string): string[] {
  const tokens = new Set(text.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
  const out: string[] = [];
  for (const a of ALLOWLIST_ASSETS) if (tokens.has(a.toUpperCase())) out.push(a.toUpperCase());
  return out;
}

export function sanitizeTreasuryPreset(
  text: string | undefined,
  noticeDays: 7 | 30 | 90 | undefined,
): string | undefined {
  if (!text) return undefined;
  if (hasBannedContent(text)) return undefined;
  const assets = extractAllowlistAssets(text);
  if (assets.length) {
    const notice = noticeDays ? ` ${noticeDays}-day notice.` : "";
    return `The creator's treasury holds ${assets.join(" + ")}.${notice} Holding the token gives no claim on it.`;
  }
  if (/\bno (treasury|backing)\b|\bunbacked\b|\bnone\b|\bno asset/i.test(text)) return "No treasury.";
  // Vague / purpose-only text with no concrete allowlisted asset → drop it.
  return undefined;
}

export type FilterResult =
  | { ok: true; value: SuggestionShape }
  | { ok: false; violations: string[] };

export type FilterOpts = {
  /** The user's own idea + form text (lowercased internally). Used to allow
   *  "index" in a name only when the user asked for it. */
  userText?: string;
};

/**
 * Validate + lightly repair a raw suggestion. Rejects (so the route can regenerate
 * once) when a free-text field carries banned/investment-framing copy. Name/ticker
 * LISTS drop offending entries; fewer than one clean name or ticker is a reject.
 * Pairing is dropped (not a reject) when it isn't a real option.
 */
export function filterSuggestion(raw: unknown, opts: FilterOpts = {}): FilterResult {
  const violations: string[] = [];
  if (!raw || typeof raw !== "object") return { ok: false, violations: ["not-an-object"] };
  const o = raw as Record<string, unknown>;
  const userText = (opts.userText ?? "").toLowerCase();
  const allowIndex = /\bindex\b/.test(userText);

  const asArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()) : [];

  const rawNames = asArr(o.names);
  const rawTickers = asArr(o.tickers);
  const description = typeof o.description === "string" ? o.description.trim() : "";
  const treasuryPreset = typeof o.treasuryPreset === "string" ? o.treasuryPreset.trim() : undefined;
  const feeSplitSuggestion = typeof o.feeSplitSuggestion === "string" ? o.feeSplitSuggestion.trim() : undefined;
  const reasoning = typeof o.reasoning === "string" ? o.reasoning.trim() : undefined;
  const rawPairing = typeof o.pairingSuggestion === "string" ? o.pairingSuggestion.trim() : undefined;

  // Free-text fields that REGENERATE on banned/investment-framing copy.
  for (const [label, text] of [
    ["description", description],
    ["treasuryPreset", treasuryPreset ?? ""],
    ["feeSplitSuggestion", feeSplitSuggestion ?? ""],
    ["reasoning", reasoning ?? ""],
  ] as const) {
    const bad = findBannedWords(text);
    if (bad.length) violations.push(`${label}: banned [${bad.join(", ")}]`);
  }
  if (violations.length) return { ok: false, violations };

  // Names: drop brand collisions, banned copy, and fund/security/index names.
  const names = rawNames
    .filter((n) => n.length > 0 && n.length <= 32)
    .filter((n) => !isBlockedName(n))
    .filter((n) => !hasBannedContent(n))
    .filter((n) => !isFundLikeName(n, allowIndex))
    .slice(0, 3);

  // Tickers: 1–10 alnum, not a blocked or fund ticker.
  const tickers = rawTickers
    .map((t) => t.replace(/^\$/, "").toUpperCase())
    .filter((t) => /^[A-Z0-9]{1,10}$/.test(t))
    .filter((t) => !isBlockedTicker(t))
    .slice(0, 3);

  if (names.length === 0) return { ok: false, violations: ["all-names-blocked"] };
  if (tickers.length === 0) return { ok: false, violations: ["all-tickers-blocked"] };
  if (!description) return { ok: false, violations: ["empty-description"] };

  const noticeDays = parseNoticeDays(o.noticeDays);
  const feeSplitBps = parseFeeSplitBps(o.feeSplitBps);

  return {
    ok: true,
    value: {
      names,
      tickers,
      description,
      pairingSuggestion: sanitizePairing(rawPairing),
      // Only a concrete allowlisted asset + notice (or "No treasury") — never a purpose.
      treasuryPreset: sanitizeTreasuryPreset(treasuryPreset, noticeDays),
      noticeDays,
      // Text is derived from the repaired bps so it never mentions the (unsupported)
      // treasury bucket and always matches the one-click Apply.
      feeSplitSuggestion: feeSplitBps ? canonicalSplitText(feeSplitBps) : undefined,
      feeSplitBps,
      reasoning,
    },
  };
}

/** Summary post-filter: summaries are a single string. Reject on banned content. */
export function isSummaryClean(text: string): boolean {
  return !hasBannedContent(text);
}
