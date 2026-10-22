import type { Address } from "viem";

// Mirror of web/lib/hiddenTokens.ts CODE_HIDDEN_TOKENS. Kept byte-identical by a
// drift test (test/hidden-tokens.test.ts). The SDK must not depend on the Next.js
// app (wrong dependency direction), so the canonical list is duplicated here and
// guarded, rather than imported across the repo root. See DECISIONS in the build
// report. All lowercased for case-insensitive compare.
export const HIDDEN_TOKENS: readonly Address[] = [
  "0x3fec2b548755d53fd8db97cac0c14dfa99f0e335", // gen-4 "TEST" factory probe
  "0x28c53790d77a23715972ae01ab7fa8430b31846f", // FeeRouter v2 smoke-test launch
];

/** True if `token` is a hidden test/smoke launch (case-insensitive). */
export function isHiddenToken(token: Address | string | undefined | null): boolean {
  if (!token) return false;
  const t = token.toLowerCase();
  return HIDDEN_TOKENS.some((a) => a.toLowerCase() === t);
}
