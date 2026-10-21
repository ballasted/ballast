// Pure Telegram message formatters (HTML parse mode, link previews off). No I/O,
// no secrets — unit-tested with recorded-log fixtures. Copy obeys the project
// rules: no "yield/reward/floor/guaranteed/safe"; burns are "sent to the dead
// address"; the bot states facts only (no price/market-cap in v1).

export type Split = { creatorBps: number; treasuryBps: number; buybackBps: number; parentBurnBps: number; rewardsBps: number };

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://www.ballasted.fun").replace(/\/$/, "");
const BLOCKSCOUT = (process.env.NEXT_PUBLIC_BLOCKSCOUT_URL || "https://robinhoodchain.blockscout.com").replace(/\/$/, "");

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function shortAddr(a: string): string {
  return a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
export function txLink(hash: string): string {
  return `<a href="${BLOCKSCOUT}/tx/${hash}">tx</a>`;
}
export function tokenLink(addr: string, label: string): string {
  return `<a href="${APP_URL}/app/token/${addr}">${esc(label)}</a>`;
}
export function ticker(symbol: string | undefined, addr: string): string {
  const s = symbol ? (symbol.startsWith("$") ? symbol : `$${symbol}`) : `$${shortAddr(addr)}`;
  return s;
}

/** Whole-number group formatting, trimming to a sensible precision. */
export function fmtAmount(x: number, maxFrac = 4): string {
  if (!Number.isFinite(x)) return "0";
  if (x === 0) return "0";
  if (x >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return x.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}
/** Format a wei (1e18) bigint as a decimal ETH/token string. */
export function fmtWei(wei: bigint, decimals = 18, maxFrac = 4): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const n = Number(whole) + Number(frac) / Number(base);
  return (neg ? "-" : "") + fmtAmount(n, maxFrac);
}

/** "creator/buyback/stakers" compact (treasury omitted — always 0 at launch). */
export function splitCompact(s: Split): string {
  const parts = [s.creatorBps, s.buybackBps, s.rewardsBps].map((b) => Math.round(b / 100));
  const base = parts.join("/");
  return s.parentBurnBps > 0 ? `${base} (+${Math.round(s.parentBurnBps / 100)} parent)` : base;
}
/** Fully labeled split, zero buckets omitted. */
export function splitLabeled(s: Split): string {
  const out: string[] = [];
  const add = (label: string, bps: number) => { if (bps > 0) out.push(`${label} ${Math.round(bps / 100)}`); };
  add("creator", s.creatorBps);
  add("treasury", s.treasuryBps);
  add("buyback", s.buybackBps);
  add("stakers", s.rewardsBps);
  add("parent", s.parentBurnBps);
  return out.join(" / ");
}

export function fmtDateUtc(unix: bigint): string {
  const d = new Date(Number(unix) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ── Message builders ─────────────────────────────────────────────────────────

export function msgLaunch(a: {
  token: string; symbol?: string; name?: string; pairs: string[]; treasury: boolean; split: Split; parentSymbol?: string; txHash: string;
}): string {
  const head = `🚀 New launch: ${tokenLink(a.token, ticker(a.symbol, a.token))}${a.name ? ` (${esc(a.name)})` : ""}`;
  const pairs = `Paired with ${a.pairs.join(" + ")}`;
  const parts = [head, pairs, `Treasury: ${a.treasury ? "yes" : "no"}`, `Split ${splitCompact(a.split)}`];
  if (a.parentSymbol) parts.push(`Parent: ${a.parentSymbol.startsWith("$") ? a.parentSymbol : `$${a.parentSymbol}`}`);
  parts.push(txLink(a.txHash));
  return parts.join(" · ");
}

export function msgSwap(a: {
  side: "buy" | "sell"; token: string; symbol?: string; ethAmount: number; tokenAmount: number; isProtocol: boolean; txHash: string;
}): string {
  const icon = a.side === "buy" ? "🟢" : "🔴";
  const verb = a.side === "buy" ? "Buy" : "Sell";
  const star = a.isProtocol ? " ⚓" : "";
  const flow = a.side === "buy"
    ? `${fmtAmount(a.ethAmount)} ETH → ${fmtAmount(a.tokenAmount)} ${ticker(a.symbol, a.token)}`
    : `${fmtAmount(a.tokenAmount)} ${ticker(a.symbol, a.token)} → ${fmtAmount(a.ethAmount)} ETH`;
  return `${icon} ${verb}${star} · ${tokenLink(a.token, ticker(a.symbol, a.token))} · ${flow} · ${txLink(a.txHash)}`;
}

export function msgBuyback(a: { ballastBurned: number; asset: string; spent: number; txHash: string }): string {
  return `🔥 Buyback &amp; burn · ${fmtAmount(a.ballastBurned)} $BALLAST sent to the dead address · ${fmtAmount(a.spent)} ${a.asset} spent · ${txLink(a.txHash)}`;
}

export function msgBurn(a: { amount: number; from: string; txHash: string }): string {
  return `🔥 Burn · ${fmtAmount(a.amount)} $BALLAST sent to the dead address by ${shortAddr(a.from)} · ${txLink(a.txHash)}`;
}

export function msgSplitScheduled(a: { token: string; symbol?: string; split: Split; effectiveAt: bigint; txHash: string }): string {
  return `⚙️ Fee split scheduled · ${tokenLink(a.token, ticker(a.symbol, a.token))} · ${splitLabeled(a.split)} · effective ${fmtDateUtc(a.effectiveAt)} · ${txLink(a.txHash)}`;
}

export function msgSplitApplied(a: { token: string; symbol?: string; split: Split; instant: boolean; txHash: string }): string {
  return `⚙️ Fee split ${a.instant ? "applied" : "now active"} · ${tokenLink(a.token, ticker(a.symbol, a.token))} · ${splitLabeled(a.split)} · ${txLink(a.txHash)}`;
}

export function msgParentBurn(a: { parent: string; parentSymbol?: string; parentOut: number; txHash: string }): string {
  return `🔥 Parent burn · ${fmtAmount(a.parentOut)} ${ticker(a.parentSymbol, a.parent)} sent to the dead address · ${txLink(a.txHash)}`;
}

export function msgTreasuryDeposit(a: { token: string; symbol?: string; assetSymbol: string; amount: number; txHash: string }): string {
  return `🏦 Treasury deposit · ${tokenLink(a.token, ticker(a.symbol, a.token))} · ${fmtAmount(a.amount)} ${a.assetSymbol} · ${txLink(a.txHash)}`;
}

export function msgBasketFill(a: { token: string; symbol?: string; ethIn: number; nAssets: number; txHash: string }): string {
  return `🧺 Basket filled · ${tokenLink(a.token, ticker(a.symbol, a.token))} · ${fmtAmount(a.ethIn)} ETH into ${a.nAssets} assets · ${txLink(a.txHash)}`;
}

export function msgDigest(n: number, counts: Record<string, number>): string {
  const parts = Object.entries(counts).filter(([, c]) => c > 0).map(([k, c]) => `${c} ${k}`);
  return `📊 ${n} more on-chain events this cycle · ${parts.join(" · ")}`;
}
