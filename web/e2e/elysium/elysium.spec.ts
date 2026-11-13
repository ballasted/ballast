import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { readFixture } from "./fixture";
import { acceptTermsIfShown } from "../helpers";

// The connect button on desktop lives in the icon rail (compact ConnectButton),
// not a banner, so match it anywhere by accessible name.
function connectButton(page: Page) {
  return page.getByRole("button", { name: /connect wallet/i }).first();
}

// Gen-5 (Elysium) UI e2e against a real anvil fork of 99901 with a freshly
// launched+graduated token (e2e/elysium/global-setup.ts). The on-chain write
// correctness (buy/sell/limit calldata) is proven headlessly by
// scripts/elysiumForkSmoke.mts; these cover the browser/React wiring on top.

test("create page renders the gen-5 launch flow (WHYPE, fee picker, fixed-forever, split)", async ({ page }) => {
  await page.goto("/app/create");
  await expect(page.getByText("Gen 5 · beta").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("WHYPE").first()).toBeVisible();
  await expect(page.getByText(/fixed forever at launch/i)).toBeVisible();
  await expect(page.getByText("Creator fee split")).toBeVisible();
});

test("token page renders the gen-5 view + exact protocol-share wording", async ({ page }) => {
  const { token } = readFixture();
  await page.goto(`/app/token/${token}`);
  await expect(page.getByText("Gen 5 · beta").first()).toBeVisible({ timeout: 20_000 });
  // exact required wording
  await expect(
    page.getByText(
      "On Elysium, the protocol share accrues to the Ballast Safe (2-of-3) and is used for $BALLAST buyback & burn once the bridge is live.",
    ),
  ).toBeVisible();
  await expect(page.getByText("Limit order").first()).toBeVisible({ timeout: 25_000 });
});

test("connect wallet + buy on the gen-5 token page", async ({ page }) => {
  const { token } = readFixture();
  await page.addInitScript({ path: path.join(__dirname, "inject-wallet-ely.js") });
  await page.goto(`/app/token/${token}`);

  await connectButton(page).click();
  await acceptTermsIfShown(page);

  // Enter a buy amount (HYPE) and submit.
  const amount = page.getByPlaceholder("0.0").first();
  await amount.fill("0.5");
  const buyBtn = page.getByRole("button", { name: /^Buy / });
  await expect(buyBtn).toBeEnabled({ timeout: 20_000 });
  await buyBtn.click();
  await expect(page.getByText(/Swap confirmed/i)).toBeVisible({ timeout: 60_000 });
});
