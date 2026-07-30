"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

// Project mark. Renders the pinned image (via `src`, an already-resolved gateway
// URL) and falls back to the deterministic ticker-initials mark if there's no
// image or it fails to load — so a broken/unpinned CID never shows a broken image.
export function Logo({
  src,
  symbol,
  size = 40,
  className,
}: {
  src?: string;
  symbol?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initials = (symbol || "•").slice(0, 3);

  if (src && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={symbol ? `${symbol} logo` : "project logo"}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  // No uploaded image → ticker initials on a NEUTRAL surface circle. Never a
  // coloured placeholder (Discover/create Phase 1): a per-ticker hue read as a bug
  // and belonged to no part of the palette.
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-surface-raised font-semibold uppercase text-bone-muted",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.32 }}
    >
      {initials}
    </div>
  );
}
