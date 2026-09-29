"use client";

import { useEffect, useState } from "react";

// No component centralized `prefers-reduced-motion` detection before this — the
// existing motion in globals.css (@media (prefers-reduced-motion: reduce)) zeroes
// out CSS animation/transition durations globally, which is enough for CSS-driven
// effects. JS-driven animation (a requestAnimationFrame tween, e.g. a chart's
// count-up price label) doesn't go through CSS at all, so it needs this to know
// when to skip straight to the end value instead of easing toward it. Starts
// `false` (matchMedia doesn't exist during SSR) and corrects on mount — one frame
// of default motion is preferable to guessing wrong before the browser is known.
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
