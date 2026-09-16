"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { tickerLogoFor } from "@/lib/tickerLogos";

// The round asset mark used everywhere a token or reserve asset needs an icon
// (spec §3, "glass discs"): the pinned image (via `src`, an already-resolved
// gateway URL), with a radial highlight top-left, an inner shadow bottom, a
// 1px inner ring, and a patina-tinted outer glow. Falls back to deterministic
// ticker initials on a neutral surface when there's no image or it fails to
// load, so a broken/unpinned CID never shows a broken image. Canonical sizes
// are 24 / 32 / 48 / 64 / 96 (see /app/styleguide) but `size` accepts any pixel
// value so existing call sites keep their exact density.
//
// `reserveAsset` opts into the local trademarked-logo set (AssetRegistry
// allowlist + quote-asset candidates — see lib/tickerLogos.ts) resolved by
// ticker. This is gated behind an explicit flag, not automatic symbol
// matching, so a project token whose symbol happens to collide with a real
// asset's ticker (a documented impersonation risk on this chain) can never
// inherit that asset's trademark just by symbol match — only call sites that
// are actually displaying the reserve asset itself set this. It also only
// activates when no explicit `src` is passed, so it never overrides a
// caller-resolved image.
export function AssetDisc({
  src,
  symbol,
  size = 40,
  reserveAsset = false,
  className,
}: {
  src?: string;
  symbol?: string;
  size?: number;
  reserveAsset?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initials = (symbol || "•").slice(0, 3);

  const tickerLogo = reserveAsset && !src ? tickerLogoFor(symbol, size) : undefined;

  if (tickerLogo && !failed) {
    // Real third-party trademarks: no recolor, no patina tint, no sheen — the
    // mark renders as-is, scaled per-shape to sit visually consistent with the
    // rest of the family rather than filling the disc edge-to-edge.
    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-raised ring-1 ring-inset ring-bone/10",
          className,
        )}
        style={{ width: size, height: size }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/assets/tickers/${tickerLogo.file}`}
          alt={`${symbol} logo`}
          onError={() => setFailed(true)}
          style={{ width: size * tickerLogo.scale, height: size * tickerLogo.scale }}
          className="object-contain"
        />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-inset ring-bone/10",
        className,
      )}
      style={{
        width: size,
        height: size,
        boxShadow: "0 0 0 1px rgba(34,201,58,0.14), 0 2px 10px -2px rgba(34,201,58,0.35)",
      }}
    >
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={symbol ? `${symbol} logo` : "asset logo"}
          width={size}
          height={size}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center bg-surface-raised font-semibold uppercase text-bone-muted"
          style={{ fontSize: size * 0.32 }}
        >
          {initials}
        </span>
      )}
      {/* Glass sheen — fixed regardless of image/initials content underneath. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 30% 22%, rgba(245,243,236,0.22), rgba(245,243,236,0) 45%)",
          mixBlendMode: "overlay",
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{ boxShadow: "inset 0 -3px 4px rgba(0,0,0,0.35)" }}
      />
    </span>
  );
}
