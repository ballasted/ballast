"use client";

import { useCallback, useEffect, useState } from "react";
import { readPref, writePref } from "@/lib/uiPrefs";

/** Blurs every monetary figure app-wide (spec §4, App shell) via a
 *  `data-blur-balances` attribute on <body> that globals.css targets. Starts
 *  false on every render (server and first client paint match, so no
 *  hydration warning) and only picks up the persisted value in an effect
 *  after mount — a one-frame flash beats a hydration mismatch. */
export function useBlurBalances() {
  const [blurred, setBlurred] = useState(false);

  useEffect(() => {
    setBlurred(readPref("blur-balances", "false") === "true");
  }, []);

  useEffect(() => {
    document.body.dataset.blurBalances = blurred ? "true" : "false";
  }, [blurred]);

  const toggle = useCallback(() => {
    setBlurred((prev) => {
      const next = !prev;
      writePref("blur-balances", String(next));
      return next;
    });
  }, []);

  return { blurred, toggle };
}
