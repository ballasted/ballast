"use client";

import { useEffect, useRef, useState } from "react";
import { tickerLogoFor } from "@/lib/tickerLogos";

/**
 * The hero-orbit disc: a real ticker logo image, or — ONLY when that image
 * actually fails to load — the full ticker symbol, auto-sized to fit the disc
 * (never truncated, never clipped). Disc chrome (ring/shadow/sheen) matches
 * AssetDisc's generic treatment exactly; this is a separate, minimal component
 * (not a reuse of AssetDisc) because AssetDisc's own fallback truncates to 3
 * characters and its logo image fills the disc edge-to-edge — neither matches
 * this spec (per-symbol inset, contain-fit, never-truncated fallback).
 *
 * Logo inset is per-symbol (lib/tickerLogos.ts's `scale`, already tuned per
 * mark — wide wordmarks like SPY/QQQ/AVGO run larger, square icons smaller),
 * not a flat percentage — a flat size is exactly why logos read "tiny and
 * inconsistent" before this.
 */
export function OrbitDisc({ symbol, size = 56 }: { symbol: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const logo = tickerLogoFor(symbol, size);
  // Use the real mapped file (correct extension — some marks are .svg, not
  // .png) when one exists; otherwise still attempt a plain <SYMBOL>.png guess
  // so every disc always renders an <img>, and an unmapped ticker degrades via
  // the same onError path rather than silently skipping the image entirely.
  const file = logo?.file ?? `${symbol}.png`;
  const inset = logo?.scale ?? 0.56;
  const showImage = !failed;

  // This is server-rendered: the browser can start (and fail) loading the
  // <img> before React hydrates and attaches onError — a native `error` event
  // fires once, at load time, and does NOT wait around for a listener, so a
  // failure that lands before hydration is otherwise missed forever and the
  // broken image just sits there. On mount, check whether it already finished
  // loading with nothing to show (complete && naturalWidth 0) and fall back
  // the same way onError would.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [file]);

  // Auto-fit the fallback text: shrink font-size as the symbol gets longer so
  // the full ticker always fits the disc, never overflowing or needing an
  // ellipsis. Tuned for a bold uppercase sans at ~0.62em average char width.
  const fontSize = Math.min(size * 0.4, (size * 0.78) / (symbol.length * 0.62));

  return (
    <span
      className="hero-orbit-disc relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-inset ring-bone/10"
      style={{
        width: size,
        height: size,
        boxShadow: "0 0 0 1px rgba(34,201,58,0.14), 0 2px 10px -2px rgba(34,201,58,0.35)",
      }}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={`/assets/tickers/${file}`}
          alt={symbol}
          onError={() => setFailed(true)}
          style={{ width: `${inset * 100}%`, height: `${inset * 100}%` }}
          className="hero-orbit-disc-img object-contain"
        />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center bg-surface-raised text-center font-semibold uppercase leading-none text-bone-muted"
          style={{ fontSize }}
        >
          {symbol}
        </span>
      )}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background: "radial-gradient(circle at 30% 22%, rgba(245,243,236,0.22), rgba(245,243,236,0) 45%)",
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
