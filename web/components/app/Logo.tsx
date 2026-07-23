"use client";

import { useState } from "react";
import { colorFor } from "@/lib/metadata";
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

  return (
    <div
      className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold text-white", className)}
      style={{ width: size, height: size, background: colorFor(symbol || "•"), fontSize: size * 0.3 }}
    >
      {initials}
    </div>
  );
}
