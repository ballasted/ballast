import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address } from "viem";
import { isHiddenToken } from "@/lib/contracts";
import { cardDefaults, type ShareEventType } from "@/lib/shareCards";

export const runtime = "nodejs";

// Parametric event share card — one green card per event type (launch, buyback &
// burn, manual burn, backing added, split scheduled, basket filled, burn-to-vote
// winner). Flat BALLAST style, rounded keel mark, #00C805. Hidden (test/smoke)
// tokens never get a card. Cached: the inputs are facts carried in the query, so a
// card is immutable for a given URL — cache hard.
const C = {
  bg: "#050A06",
  card: "#0E1410",
  border: "rgba(0,200,5,0.18)",
  green: "#00C805",
  greenDeep: "#0B2A0F",
  bone: "#F5F3EC",
  boneMuted: "rgba(245,243,236,0.4)",
  faint: "rgba(245,243,236,0.18)",
  // Decorative layers (design bar relaxed slightly for share surfaces): a soft
  // patina glow top-right + a near-black deep-green pool bottom-left give depth
  // without a hard gradient wash; the divider reads as a lit keel-line.
  glow: "radial-gradient(1120px 560px at 88% -14%, rgba(0,200,5,0.16), rgba(0,200,5,0) 60%), radial-gradient(760px 520px at -10% 116%, rgba(11,42,15,0.9), rgba(11,42,15,0) 58%)",
  rule: "linear-gradient(90deg, rgba(0,200,5,0.5), rgba(0,200,5,0.06) 52%, rgba(0,200,5,0))",
};
const SIZE = { width: 1200, height: 630 };
const VALID: ShareEventType[] = ["launch", "buyback", "burn", "backing", "split", "basket", "vote-winner"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = (url.searchParams.get("type") ?? "") as ShareEventType;
  const token = url.searchParams.get("token") as Address | null;

  // Hidden tokens never get a share card — fall back to the static site card.
  if ((token && isHiddenToken(token)) || !VALID.includes(type)) {
    try {
      const fallback = await readFile(join(process.cwd(), "public", "og.png"));
      return new Response(new Uint8Array(fallback), { headers: { "content-type": "image/png", "cache-control": "public, max-age=300" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  const d = cardDefaults(type);
  const ticker = url.searchParams.get("ticker") ?? undefined;
  const value = url.searchParams.get("value") ?? undefined;
  const valueLabel = url.searchParams.get("valueLabel") ?? d.valueLabel ?? undefined;
  const sub = url.searchParams.get("sub") ?? undefined;

  try {
    return new ImageResponse(
      (
        <div style={{ position: "relative", overflow: "hidden", width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", backgroundColor: C.bg, backgroundImage: C.glow, padding: 64, fontFamily: "sans-serif" }}>
          {/* Oversized keel watermark bleeding off the bottom-right corner. Low
              opacity — a texture, not a second logo. Absolute, so it never shifts
              the three content rows below. */}
          <svg width="560" height="560" viewBox="0 0 24 24" fill="none" style={{ position: "absolute", right: -72, bottom: -104, opacity: 0.05 }}>
            <path d="M3 7h18" stroke={C.green} strokeWidth="1.4" strokeLinecap="round" />
            <path d="M12 7v6m0 0l-4 4h8l-4-4z" stroke={C.green} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
          </svg>

          {/* Header — keel mark + wordmark, event-type pill on the right. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
                <path d="M3 7h18" stroke={C.green} strokeWidth="2.4" strokeLinecap="round" />
                <path d="M12 7v6m0 0l-4 4h8l-4-4z" stroke={C.green} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 34, fontWeight: 600, letterSpacing: 6, color: C.bone }}>BALLAST</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 26, fontWeight: 600, letterSpacing: 2, padding: "12px 24px", borderRadius: 999, backgroundColor: C.greenDeep, border: "1px solid rgba(0,200,5,0.3)", color: C.green }}>
              {d.emoji} {d.headline}
            </div>
          </div>

          {/* Body — ticker (if any), big value, label. */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            {ticker ? (
              <span style={{ display: "flex", alignSelf: "flex-start", fontSize: 34, fontWeight: 600, letterSpacing: 4, textTransform: "uppercase", color: C.green, marginBottom: 14 }}>
                {ticker}
              </span>
            ) : null}
            <span style={{ fontSize: value && value.length > 16 ? 96 : 128, fontWeight: 700, letterSpacing: -3, color: C.bone, lineHeight: 1 }}>
              {value ?? d.headline}
            </span>
            {valueLabel ? <span style={{ display: "flex", fontSize: 40, color: C.boneMuted, marginTop: 16 }}>{valueLabel}</span> : null}
          </div>

          {/* Footer — optional context + domain. */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", height: 2, backgroundImage: C.rule, marginBottom: 24 }} />
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
              <span style={{ display: "flex", fontSize: 28, color: C.boneMuted, maxWidth: 820 }}>{sub ?? ""}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 26, color: C.faint, letterSpacing: 1 }}>
                <span style={{ display: "flex", width: 8, height: 8, borderRadius: 999, backgroundColor: C.green }} />
                ballasted.fun
              </span>
            </div>
          </div>
        </div>
      ),
      { ...SIZE, headers: { "cache-control": "public, max-age=31536000, immutable" } },
    );
  } catch {
    const fallback = await readFile(join(process.cwd(), "public", "og.png")).catch(() => null);
    if (fallback) return new Response(new Uint8Array(fallback), { headers: { "content-type": "image/png", "cache-control": "public, max-age=300" } });
    return new Response("render error", { status: 500 });
  }
}
