"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { tickerLogoFor } from "@/lib/tickerLogos";
import type { AssetIdentity } from "@/lib/assetIdentity";

// The round asset mark used everywhere a token or reserve asset needs an icon
// (spec §3, "glass discs"): the pinned image (via `src`, an already-resolved
// gateway URL), with a radial highlight top-left, an inner shadow bottom, a
// 1px inner ring, and a patina-tinted outer glow. Falls back to deterministic
// ticker initials on a neutral surface when there's no image or it fails to
// load, so a broken/unpinned CID never shows a broken image. Canonical sizes
// are 24 / 32 / 48 / 64 / 96 (see /app/styleguide) but `size` accepts any pixel
// value so existing call sites keep their exact density.
//
// `identity` opts into the local trademarked-logo set (AssetRegistry allowlist
// + quote-asset candidates — see lib/tickerLogos.ts), gated on an
// ADDRESS-VERIFIED AssetIdentity (see lib/assetIdentity.ts / useAssetIdentity),
// never a bare symbol string — a project token whose symbol happens to collide
// with a real asset's ticker (a documented impersonation risk on this chain,
// proven real: a fake "GOOGL/WETH" pool with a fabricated $6.24B reserve exists
// at a different address than the real GOOGL) must never inherit that asset's
// trademark just by symbol match. `unrecognized`/`hostile` render explicitly as
// such — never a logo, never the claimed ticker treated as legitimate. It only
// activates when no explicit `src` is passed, so it never overrides a
// caller-resolved image (an ordinary project token's own logo).
export function AssetDisc({
  src,
  symbol,
  size = 40,
  identity,
  className,
}: {
  src?: string;
  symbol?: string;
  size?: number;
  identity?: AssetIdentity;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initials = (symbol || "•").slice(0, 3);

  if (identity && identity.status !== "recognized" && !src) {
    if (identity.status === "loading") {
      return (
        <span
          aria-hidden
          className={cn("inline-block shrink-0 animate-pulse rounded-full bg-surface-raised", className)}
          style={{ width: size, height: size }}
        />
      );
    }
    // hostile or unrecognized: an explicit "not a trusted mark" treatment —
    // never the claimed ticker's initials, never a logo, never the normal
    // patina-tinted ring an ordinary asset gets.
    const hostile = identity.status === "hostile";
    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center rounded-full border border-dashed",
          hostile ? "border-warning bg-warning-bg text-warning" : "border-text-faint bg-surface-raised text-text-faint",
          className,
        )}
        style={{ width: size, height: size }}
        title={hostile ? `Claims "${identity.claimedSymbol}" but isn't the registered asset — treat as untrusted` : "Not a recognized asset"}
      >
        <span className="font-semibold" style={{ fontSize: size * 0.4 }}>
          {hostile ? "!" : "?"}
        </span>
      </span>
    );
  }

  const reserveSymbol = identity?.status === "recognized" ? identity.symbol : symbol;
  const tickerLogo = identity?.status === "recognized" && !src ? tickerLogoFor(reserveSymbol, size) : undefined;

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
          alt={`${reserveSymbol} logo`}
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
