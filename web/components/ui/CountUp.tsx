"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Count-up on FIRST load only (spec §1 motion): animates 0 → target once when a
 * value first becomes available, then holds. Later target changes (a re-fetch,
 * a live tick) snap without re-animating, so numbers don't bounce on every poll.
 * Honours prefers-reduced-motion by skipping straight to the value.
 *
 * The consumer formats the returned number itself, e.g.
 *   const n = useCountUp(marketCapUsd); formatUsd(BigInt(Math.round(n)))
 */
export function useCountUp(
  target: number,
  { duration = 650, enabled = true }: { duration?: number; enabled?: boolean } = {},
): number {
  const [value, setValue] = useState(target);
  const animated = useRef(false);

  useEffect(() => {
    if (!enabled || animated.current || !Number.isFinite(target) || target === 0) {
      setValue(target);
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setValue(target);
      return;
    }
    animated.current = true;
    let raf = 0;
    let start = 0;
    const tick = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setValue(target * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setValue(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Intentionally keyed on `target` only; `animated` guards the one-shot.
  }, [target, duration, enabled]);

  return value;
}
