import { ImageResponse } from "next/og";
import type { Address } from "viem";
import { getOgTokenData } from "@/lib/ogTokenData";
import { formatBackingPerToken } from "@/lib/format";

// Per-token link-preview card. Most people meet a token as a shared link before
// they ever see the page, so this is the real first impression. It shows only what
// can be verified on-chain — ticker, name, live price, backing per token (or "not
// ballasted") — plus the keel mark, in the same palette and layout language as the
// app. Flat: no gradient, no glow (design bar) — hierarchy carries it.
//
// It reads live chain state (getOgTokenData), so it's cached briefly rather than on
// every scrape; a preview is allowed to be a few minutes stale.
export const runtime = "nodejs";
export const revalidate = 300;

export const alt = "BALLAST token — live backing per token";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Palette — literal hex (satori can't read CSS variables), mirrored from
// tailwind.config.ts so the card matches the app exactly.
const C = {
  bg: "#0A0C0B",
  card: "#131917",
  border: "#232B25",
  green: "#00C805",
  greenDeep: "#0E2A12",
  bone: "#DDD8CA",
  boneMuted: "#8A938D",
  textPrimary: "#F2F4F2",
  faint: "#5F665F",
};

export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(address);
  const data = isAddr
    ? await getOgTokenData(address as Address)
    : { found: false, denied: false, ballasted: false };

  const ticker = data.symbol ? (data.symbol.startsWith("$") ? data.symbol : `$${data.symbol}`) : "BALLAST";
  const name = data.found
    ? data.denied
      ? "Metadata withheld"
      : (data.name ?? "Unnamed project")
    : "Token not found on Robinhood Chain";
  const price = data.priceUsd1e18 !== undefined ? formatBackingPerToken(data.priceUsd1e18) : "—";
  // Backing slot: the figure when ballasted, "Not ballasted" when it's a real token
  // with no treasury, and a neutral "—" when the address isn't a BALLAST token at all
  // (asserting "not ballasted" for a nonexistent token would be a false claim).
  const backing =
    data.ballasted && data.backingPerToken1e18 !== undefined
      ? formatBackingPerToken(data.backingPerToken1e18)
      : data.found
        ? "Not ballasted"
        : "—";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: C.bg,
          padding: 64,
          fontFamily: "sans-serif",
        }}
      >
        {/* Header — keel mark + wordmark, and a backing-status pill on the right. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
              <path d="M3 7h18" stroke={C.green} strokeWidth="2" strokeLinecap="round" />
              <path
                d="M12 7v6m0 0l-4 4h8l-4-4z"
                stroke={C.green}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
            <span style={{ fontSize: 34, fontWeight: 600, letterSpacing: 6, color: C.bone }}>BALLAST</span>
          </div>
          {/* The pill flags the positive, verified state only — a green glance-signal
              that this token has an on-chain treasury behind it. An unbacked or
              unknown token carries no pill; its backing slot below already says so,
              so the two states read differently without repeating a label. */}
          {data.ballasted && (
            <div
              style={{
                display: "flex",
                fontSize: 24,
                fontWeight: 600,
                letterSpacing: 2,
                padding: "12px 24px",
                borderRadius: 999,
                backgroundColor: C.greenDeep,
                color: C.green,
              }}
            >
              BALLASTED
            </div>
          )}
        </div>

        {/* Identity — ticker large, name beneath. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span
            style={{
              fontSize: 148,
              fontWeight: 700,
              letterSpacing: -4,
              color: C.bone,
              lineHeight: 1,
            }}
          >
            {ticker}
          </span>
          <span
            style={{
              fontSize: 42,
              color: C.boneMuted,
              marginTop: 16,
              maxWidth: 1000,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
        </div>

        {/* Figures — a divider, then price and backing (or the not-ballasted note),
            with the domain on the far right. Every value uses the same formatter, so
            decimals line up. */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", height: 2, backgroundColor: C.border, marginBottom: 28 }} />
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
            <div style={{ display: "flex", gap: 72 }}>
              <Stat label="PRICE" value={price} muted={price === "—"} />
              {data.ballasted ? (
                <Stat label="BACKING / TOKEN" value={backing} accent />
              ) : (
                <Stat label="BACKING" value={backing} muted />
              )}
            </div>
            <span style={{ display: "flex", fontSize: 26, color: C.faint, letterSpacing: 1 }}>ballasted.xyz</span>
          </div>
        </div>
      </div>
    ),
    size,
  );
}

function Stat({
  label,
  value,
  accent,
  muted,
}: {
  label: string;
  value: string;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span style={{ display: "flex", fontSize: 24, letterSpacing: 3, color: C.faint }}>{label}</span>
      <span
        style={{
          display: "flex",
          fontSize: 60,
          fontWeight: 600,
          marginTop: 8,
          color: accent ? C.green : muted ? C.boneMuted : C.textPrimary,
        }}
      >
        {value}
      </span>
    </div>
  );
}
