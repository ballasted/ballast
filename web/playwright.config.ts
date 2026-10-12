import { defineConfig, devices } from "@playwright/test";
import { APP_URL } from "./e2e/fixture";

// No `webServer` entry here on purpose: the dev server's env depends on
// addresses only known AFTER the local Anvil fork + fixture deploy
// (web/e2e/global-setup.ts), so global-setup starts `next dev` itself once
// the fixture is ready, rather than racing Playwright's own server-start
// lifecycle against that async on-chain setup.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: require.resolve("./e2e/global-setup.ts"),
  globalTeardown: require.resolve("./e2e/global-teardown.ts"),
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
