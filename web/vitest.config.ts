import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // `@/…` path alias, mirroring tsconfig, so unit tests can import app modules
  // the same way the app does.
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    // e2e/ holds Playwright specs (web/playwright.config.ts), which use a
    // different `test()` from @playwright/test — vitest's default glob
    // otherwise picks up *.spec.ts anywhere, including those.
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
