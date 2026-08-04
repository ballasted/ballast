// Development-only reconciliation checks (spec 1.4): "If two paths can disagree,
// eventually they will." When the same figure is produced by more than one code
// path, we cross-check them in development and console.warn on any mismatch, so a
// drift is caught in dev rather than shipped. Entirely no-op in production.

const DEV = process.env.NODE_ENV !== "production";

/** Warn (dev only) if two numbers that must match differ by more than `tolerance`
 *  (fractional, default 0.5%). For the same figure computed two ways. */
export function devReconcile(label: string, a?: number, b?: number, tolerance = 0.005): void {
  if (!DEV || a === undefined || b === undefined) return;
  if (a === 0 && b === 0) return;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  if (Math.abs(a - b) / denom > tolerance) {
    // eslint-disable-next-line no-console
    console.warn(`[reconcile] ${label} disagree: ${a} vs ${b}`);
  }
}

/** Same, for bigints — exact match expected. */
export function devReconcileBig(label: string, a?: bigint, b?: bigint): void {
  if (!DEV || a === undefined || b === undefined) return;
  if (a !== b) {
    // eslint-disable-next-line no-console
    console.warn(`[reconcile] ${label} disagree: ${a} vs ${b}`);
  }
}
