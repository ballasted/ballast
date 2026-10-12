import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/ holds Playwright specs (web/playwright.config.ts), which use a
    // different `test()` from @playwright/test — vitest's default glob
    // otherwise picks up *.spec.ts anywhere, including those.
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
