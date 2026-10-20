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
        <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", backgroundColor: C.bg, padding: 64, fontFamily: "sans-serif" }}>
          {/* Header — keel mark + wordmark, event-type pill on the right. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
                <path d="M3 7h18" stroke={C.green} strokeWidth="2.4" strokeLinecap="round" />
                <path d="M12 7v6m0 0l-4 4h8l-4-4z" stroke={C.green} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 34, fontWeight: 600, letterSpacing: 6, color: C.bone }}>BALLAST</span>
            </div>
            <div style={{ display: "flex", fontSize: 26, fontWeight: 600, letterSpacing: 2, padding: "12px 24px", borderRadius: 999, backgroundColor: C.greenDeep, color: C.green }}>
              {d.emoji} {d.headline}
            </div>
          </div>

          {/* Body — ticker (if any), big value, label. */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            {ticker ? <span style={{ display: "flex", fontSize: 48, color: C.boneMuted, marginBottom: 8 }}>{ticker}</span> : null}
            <span style={{ fontSize: value && value.length > 16 ? 96 : 128, fontWeight: 700, letterSpacing: -3, color: C.bone, lineHeight: 1 }}>
              {value ?? d.headline}
            </span>
            {valueLabel ? <span style={{ display: "flex", fontSize: 40, color: C.boneMuted, marginTop: 16 }}>{valueLabel}</span> : null}
          </div>

          {/* Footer — optional context + domain. */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", height: 2, backgroundColor: C.border, marginBottom: 24 }} />
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
              <span style={{ display: "flex", fontSize: 28, color: C.boneMuted, maxWidth: 820 }}>{sub ?? ""}</span>
              <span style={{ display: "flex", fontSize: 26, color: C.faint, letterSpacing: 1 }}>ballasted.fun</span>
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
