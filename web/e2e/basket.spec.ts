import { test, expect } from "@playwright/test";
import path from "node:path";
import { readFixture } from "./fixture";
import { acceptTermsIfShown, connectWalletButton } from "./helpers";

// Full picker flow against a real local Anvil fork of Robinhood Chain mainnet
// (web/e2e/global-setup.ts): a real BasketZap deployed against the real
// factory/registry/WETH/router/permit2, a real fresh launch, and a real
// locally-seeded NVDA/WETH pool (routability and AssetRegistry allowlisting
// are independent — see docs/BASKET_DISCOVERY.md §2 / docs/DECISIONS.md §3).
// The connected wallet is Anvil's well-known default dev account #0 (public,
// zero real value), driven via a local injected-provider bridge
// (web/e2e/wallet-bridge.mjs) — never a real key, never real mainnet.
test("creator adds a one-asset basket end-to-end and sees it on the backing page", async ({ page }) => {
  const fixture = readFixture();

  await page.addInitScript({ path: path.join(__dirname, "inject-wallet.js") });
  // Backing moved off the token page onto its own route (docs/DECISIONS.md
  // §5) — the picker now lives here, not behind a token-page tab.
  await page.goto(`/app/backing/${fixture.token}`);

  await connectWalletButton(page).click();
  await expect(page.getByText(/0xf39F/i)).toBeVisible({ timeout: 15_000 });

  await acceptTermsIfShown(page);

  const basketSection = page.locator("section", { hasText: "Basket" }).first();
  await basketSection.getByRole("button", { name: "Add basket" }).click();

  // Pick NVDA directly as a single-asset (100%) custom basket. NVDA is in the
  // production routable set (web/lib/basketRoutes.ts) and the fork has the real
  // WETH/NVDA Ramses pool, so this quotes and swaps for real — no seeded route.
  // (A preset like "AI chips" now resolves to multiple routable assets, which
  // would make the single-asset deposit assertions below ambiguous.)
  await basketSection.getByRole("button", { name: "NVDA logo NVDA" }).click();
  await expect(basketSection.getByRole("button", { name: "NVDA logo NVDA" })).toHaveClass(/chip-active/);

  await basketSection.getByPlaceholder("0.0").fill("0.5");

  // Live Ramses quote preview for the NVDA leg.
  await expect(basketSection.getByText(/→.*NVDA/)).toBeVisible({ timeout: 15_000 });

  // The injected test wallet has no EIP-5792 support (the capability probe
  // throws), so this is the STEP flow, and the upfront count must show the
  // real total: 1 swap + 1 approve (fresh account, no allowance) + 1 deposit.
  await expect(basketSection.getByText(/needs 3 confirmations/)).toBeVisible({ timeout: 15_000 });

  const swapButton = basketSection.getByRole("button", { name: "Swap & review" });
  await expect(swapButton).toBeEnabled({ timeout: 10_000 });
  await swapButton.click();

  await expect(basketSection.getByText("Swap ETH into 1 asset")).toBeVisible();
  await expect(basketSection.getByText("Approve treasury to pull NVDA")).toBeVisible();
  await expect(basketSection.getByText("Deposit NVDA into treasury")).toBeVisible();

  // Each step must reach success (rendered as a filled green dot — asserted
  // indirectly via the "Done" button only appearing once the runner marks
  // the whole sequence complete).
  const doneButton = basketSection.getByRole("button", { name: "Done" });
  await expect(doneButton).toBeVisible({ timeout: 30_000 });
  await doneButton.click();

  // Reload and confirm the basket's history card shows the real deposit,
  // read back through the same real BackingLens call the rest of the page
  // uses.
  await page.reload();
  const basketSectionAfter = page.locator("section", { hasText: "Basket" }).first();
  // .first(): when the batched spec ran earlier in the same session, history
  // already shows its swap too — several 100% legs is expected, not an error.
  await expect(basketSectionAfter.getByText("100%").first()).toBeVisible({ timeout: 15_000 });
  await expect(
    basketSectionAfter.getByText("Holding $E2EB gives no claim, redemption right, or entitlement to these assets."),
  ).toBeVisible();
});
