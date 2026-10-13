import { test, expect } from "@playwright/test";
import path from "node:path";
import { readFixture } from "./fixture";
import { acceptTermsIfShown, connectWalletButton } from "./helpers";

// Batched (EIP-5792) basket flow against the same local Anvil fork as
// basket.spec.ts, with the injected test wallet's MOCKED atomic-batch support
// switched on (window.__E2E_ATOMIC__ — see web/e2e/inject-wallet.js). The mock
// advertises `atomic: supported` via wallet_getCapabilities and executes
// wallet_sendCalls as sequential real transactions on the fork, so this test
// asserts the app's batched-flow contract — capability detection routes to ONE
// confirmation, the batch dispatches swap + approve + deposit, and the deposit
// lands — not wallet-side atomicity (the contract-level all-or-nothing is
// proven in the forge fork suite).
test("creator adds a basket in one confirmation when the wallet supports atomic batching (mocked)", async ({ page }) => {
  const fixture = readFixture();

  await page.addInitScript(() => {
    (window as unknown as { __E2E_ATOMIC__: boolean }).__E2E_ATOMIC__ = true;
  });
  await page.addInitScript({ path: path.join(__dirname, "inject-wallet.js") });
  await page.goto(`/app/backing/${fixture.token}`);

  await connectWalletButton(page).click();
  await expect(page.getByText(/0xf39F/i)).toBeVisible({ timeout: 15_000 });

  await acceptTermsIfShown(page);

  const basketSection = page.locator("section", { hasText: "Basket" }).first();
  await basketSection.getByRole("button", { name: "Add basket" }).click();

  await basketSection.getByRole("button", { name: "NVDA logo NVDA" }).click();
  await expect(basketSection.getByRole("button", { name: "NVDA logo NVDA" })).toHaveClass(/chip-active/);

  await basketSection.getByPlaceholder("0.0").fill("0.2");

  // Live Ramses quote for the NVDA leg.
  await expect(basketSection.getByText(/→.*NVDA/)).toBeVisible({ timeout: 15_000 });

  // Capability detection picked the batched path: the upfront count says 1.
  await expect(basketSection.getByText(/needs 1 confirmation/)).toBeVisible({ timeout: 15_000 });

  const swapButton = basketSection.getByRole("button", { name: "Swap & review" });
  await expect(swapButton).toBeEnabled({ timeout: 10_000 });
  await swapButton.click();

  // ONE batch step — no separate approve/deposit steps.
  await expect(basketSection.getByText(/Confirm basket — 1 signature/)).toBeVisible();
  await expect(basketSection.getByText("Approve treasury to pull NVDA")).toHaveCount(0);

  const doneButton = basketSection.getByRole("button", { name: "Done" });
  await expect(doneButton).toBeVisible({ timeout: 30_000 });
  await doneButton.click();

  // Reload and confirm the deposit actually landed (history + real BackingLens
  // readback through the same path the page always uses).
  await page.reload();
  const basketSectionAfter = page.locator("section", { hasText: "Basket" }).first();
  await expect(basketSectionAfter.getByText("100%").first()).toBeVisible({ timeout: 15_000 });
  await expect(
    basketSectionAfter.getByText("Holding $E2EB gives no claim, redemption right, or entitlement to these assets."),
  ).toBeVisible();
});
