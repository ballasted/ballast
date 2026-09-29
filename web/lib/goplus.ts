// GoPlus token_security API — a third-party security scan, called ONLY server-side
// (see app/api/security-check/route.ts) and never directly from the browser.
//
// The load-bearing fact this module exists to encode: GoPlus OMITS `is_honeypot`
// (and other fields) entirely from its response for an unverified-source token —
// it is not `"0"` (a false/pass), it is simply absent (docs/scanner-outreach.md,
// verified live against BALLAST v1 vs v2 2026-09-29). That absence must render as
// "Unknown," never default to a green Pass. CLAUDE.md / the live instruction for
// this feature: "No fake greens." Every derive* function below is unknown-first —
// a field is only ever pass/fail when GoPlus returned an explicit, definitive
// value for it.

export type CheckStatus = "pass" | "fail" | "unknown";

export type SecurityCheckRow = {
  status: CheckStatus;
  value: string; // human label, always safe to render even when status is "unknown"
};

export type SecurityCheckResult = {
  // false = GoPlus's response had no entry at all for this address (token too
  // new / never indexed) — distinct from "scanned, but this one field is absent".
  scanned: boolean;
  tokenName?: string;
  tokenSymbol?: string;
  holderCount?: number;
  verifiedSource: SecurityCheckRow; // is_open_source
  honeypot: SecurityCheckRow; // is_honeypot — the field most often absent
  buyTax: SecurityCheckRow; // buy_tax
  sellTax: SecurityCheckRow; // sell_tax
  cannotBuy: SecurityCheckRow; // cannot_buy
  transferPausable: SecurityCheckRow; // transfer_pausable
  anyFail: boolean;
  anyUnknown: boolean;
};

// Raw GoPlus per-address shape (only the fields this feature reads). Every
// present field is a numeric-string ("0"/"1") or a decimal-string tax ratio per
// GoPlus's own docs; a field being ABSENT (not present as a key at all) is the
// literal on-the-wire meaning of "not determined for this token."
export type GoPlusRawEntry = {
  is_open_source?: string;
  is_honeypot?: string;
  buy_tax?: string;
  sell_tax?: string;
  cannot_buy?: string;
  transfer_pausable?: string;
  holder_count?: string;
  token_name?: string;
  token_symbol?: string;
};

export type GoPlusApiResponse = {
  code: number;
  message: string;
  result?: Record<string, GoPlusRawEntry>;
};

// Robinhood Chain's GoPlus chain id — confirmed live 2026-09-29 (chain "Robinhood",
// id "4663" appears in GoPlus's own supported_chains list).
export const GOPLUS_CHAIN_ID = "4663";

export const GOPLUS_API_BASE = `https://api.gopluslabs.io/api/v1/token_security/${GOPLUS_CHAIN_ID}`;

// GoPlus's own docs don't publish a hard per-call address cap for this endpoint;
// 30 is a conservative, commonly-cited batch size for similar multi-address
// GoPlus endpoints, kept here as a single constant so the server route can chunk
// large requests instead of sending one unbounded URL.
export const GOPLUS_MAX_ADDRESSES_PER_CALL = 30;

// The exact URL GoPlus was queried at — this doubles as the "proof link": GoPlus
// has no consumer-facing per-token page, but this URL returns the raw JSON
// directly in a browser, so linking it is a real, independently-checkable proof
// rather than a dead end.
export function goPlusApiUrl(addresses: string[]): string {
  const qs = addresses.map((a) => a.toLowerCase()).join(",");
  return `${GOPLUS_API_BASE}?contract_addresses=${qs}`;
}

// pass when the raw flag is exactly "0", fail when exactly "1", unknown otherwise
// (including "not present" and any unexpected value) — used for flags where "0"
// is the safe/desired state (honeypot, cannot-buy, transfer-pausable).
function zeroIsPassRow(raw: string | undefined, passLabel: string, failLabel: string): SecurityCheckRow {
  if (raw === "0") return { status: "pass", value: passLabel };
  if (raw === "1") return { status: "fail", value: failLabel };
  return { status: "unknown", value: "Not reported" };
}

// pass when the raw flag is exactly "1" (open-source is the desired state at 1).
function oneIsPassRow(raw: string | undefined, passLabel: string, failLabel: string): SecurityCheckRow {
  if (raw === "1") return { status: "pass", value: passLabel };
  if (raw === "0") return { status: "fail", value: failLabel };
  return { status: "unknown", value: "Not reported" };
}

// GoPlus reports tax as a 0–1 decimal string. 0% is the definitive pass; any
// reported nonzero value is a definitive, GoPlus-confirmed fee on the trade —
// shown as fail so it isn't lost among unrelated "pass" chips, with the exact
// percentage always visible in the value text. Absent stays unknown.
function taxRow(raw: string | undefined): SecurityCheckRow {
  if (raw === undefined) return { status: "unknown", value: "Not reported" };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { status: "unknown", value: "Not reported" };
  const pct = n * 100;
  const label = `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}%`;
  return { status: pct > 0 ? "fail" : "pass", value: label };
}

// Derives the normalized, render-safe result for one address from GoPlus's raw
// entry. `entry` is undefined when GoPlus's response simply has no key for this
// address at all — every row then correctly falls out as "unknown" via the
// helpers above (they all treat `undefined` as "not reported").
export function deriveSecurityCheck(entry: GoPlusRawEntry | undefined): SecurityCheckResult {
  const verifiedSource = oneIsPassRow(entry?.is_open_source, "Verified source", "Not verified");
  const honeypot = zeroIsPassRow(entry?.is_honeypot, "Not a honeypot", "Honeypot");
  const buyTax = taxRow(entry?.buy_tax);
  const sellTax = taxRow(entry?.sell_tax);
  const cannotBuy = zeroIsPassRow(entry?.cannot_buy, "Can be bought", "Cannot be bought");
  const transferPausable = zeroIsPassRow(entry?.transfer_pausable, "Not pausable", "Pausable");

  const rows = [verifiedSource, honeypot, buyTax, sellTax, cannotBuy, transferPausable];
  return {
    scanned: entry !== undefined,
    tokenName: entry?.token_name,
    tokenSymbol: entry?.token_symbol,
    holderCount: entry?.holder_count !== undefined ? Number(entry.holder_count) : undefined,
    verifiedSource,
    honeypot,
    buyTax,
    sellTax,
    cannotBuy,
    transferPausable,
    anyFail: rows.some((r) => r.status === "fail"),
    anyUnknown: rows.some((r) => r.status === "unknown"),
  };
}
