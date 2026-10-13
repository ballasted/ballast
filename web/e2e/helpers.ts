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

  const checkboxes = page.getByRole("checkbox");
  const count = await checkboxes.count();
  for (let i = 0; i < count; i++) {
    const box = checkboxes.nth(i);
    for (let attempt = 0; attempt < 8 && !(await box.isChecked()); attempt++) {
      // .check()'s own post-click verification throws on the exact flake
      // this is working around, which would abort the loop before it gets a
      // second attempt — .click() has no such verification, so pair it with
      // the isChecked() loop condition above to confirm the real result.
      try {
        await box.click({ force: true });
      } catch {
        /* retry */
      }
      await page.waitForTimeout(250);
    }
  }
  await acceptButton.click();
}
