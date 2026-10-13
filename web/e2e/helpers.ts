import type { Page } from "@playwright/test";

/**
 * The nav header's connect button, specifically — some creator-only sections
 * on the backing page (e.g. CreatorWithdrawalPanel) ALSO render their own
 * "Connect wallet" CTA inline when no wallet is connected, so a bare
 * `getByRole("button", { name: "Connect wallet" })` is ambiguous (Playwright
 * strict mode) once that section has rendered. The header's is the canonical
 * one and always present.
 */
export function connectWalletButton(page: Page) {
  return page.getByRole("banner").getByRole("button", { name: "Connect wallet" });
}

/**
 * First-connect terms gate, if shown. Retries each checkbox a few times —
 * under sustained sequential test load in this harness (several
 * wallet-connecting tests back to back against one shared Anvil fork +
 * `next dev` instance), a single `.check({ force: true })` occasionally
 * reports success without the underlying state actually flipping (not
 * reproducible in isolation — see docs/DECISIONS.md §5). Re-checking is a
 * real, honest retry of the same user action, not a different one.
 */
export async function acceptTermsIfShown(page: Page): Promise<void> {
  const acceptButton = page.getByRole("button", { name: "Accept and continue" });
  if (!(await acceptButton.isVisible().catch(() => false))) return;

  // Gate on the REAL success condition — the button enabling — not on the
  // checkboxes' DOM state. A click that lands before React hydrates flips the
  // DOM `checked` without updating React's controlled state, so isChecked()
  // reports true while the button stays disabled forever (observed under
  // sequential-suite load; docs/DECISIONS.md §5). Recovery for that desync is
  // a double-click (off, then on) once hydration has caught up, which is what
  // the per-round logic below converges to.
  for (let round = 0; round < 20 && !(await acceptButton.isEnabled().catch(() => false)); round++) {
    const checkboxes = page.getByRole("checkbox");
    const count = await checkboxes.count();
    for (let i = 0; i < count; i++) {
      const box = checkboxes.nth(i);
      try {
        if (!(await box.isChecked())) {
          // Normal path: check an unchecked box.
          await box.click({ force: true });
        } else if (round > 0) {
          // Box reads checked but the button still isn't enabled — the
          // DOM/React desync above. Toggle off and on to resync.
          await box.click({ force: true });
          await page.waitForTimeout(100);
          await box.click({ force: true });
        }
      } catch {
        /* retry next round */
      }
    }
    await page.waitForTimeout(400);
  }
  await acceptButton.click();
}
