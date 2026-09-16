"use client";

import { useCallback, useEffect, useState } from "react";
import { readPref, writePref } from "@/lib/uiPrefs";

export type Density = "comfortable" | "compact";

/** Comfortable (44px rows, default) vs Compact (32px, for the terminal view) —
 *  spec §3, "Density". Tables read `var(--row-height)`; this hook only flips
 *  a `data-density` attribute on <body> that globals.css maps to that
 *  variable. Same mount-then-effect pattern as useBlurBalances, for the same
 *  hydration reason. */
export function useDensity() {
  const [density, setDensityState] = useState<Density>("comfortable");

  useEffect(() => {
    const stored = readPref("density", "comfortable");
    if (stored === "compact") setDensityState("compact");
  }, []);

  useEffect(() => {
    document.body.dataset.density = density;
  }, [density]);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    writePref("density", next);
  }, []);

  return { density, setDensity };
}
