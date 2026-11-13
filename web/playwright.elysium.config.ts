import { defineConfig, devices } from "@playwright/test";
import { APP_URL } from "./e2e/elysium/fixture";

// Elysium (gen-5) e2e — separate from the Robinhood config so both can run
// independently. global-setup forks 99901, launches+graduates a gen-5 token, and
// boots `next dev` with NEXT_PUBLIC_CHAIN=elysium. See e2e/elysium/global-setup.ts.
//
// Run: npx playwright test --config=playwright.elysium.config.ts
// For a reliable run set ELYSIUM_FORK_RPC to a dedicated RPC (the public backup
// rpc.elyscan.live is rate-limited / non-archive).
export default defineConfig({
  testDir: "./e2e/elysium",
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: require.resolve("./e2e/elysium/global-setup.ts"),
  globalTeardown: require.resolve("./e2e/elysium/global-teardown.ts"),
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
