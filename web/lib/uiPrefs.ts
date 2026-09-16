// UI-only preferences (theme, density, blur-balances, chart timeframe, collapsed
// rail) — never anything sensitive. Namespaced so they don't collide with
// anything else that might use localStorage on this origin (spec §2).
const PREFIX = "ballast:";

export function readPref(key: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(PREFIX + key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    /* storage disabled or full — the preference just won't persist */
  }
}
