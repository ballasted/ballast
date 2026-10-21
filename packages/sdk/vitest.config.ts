import { defineConfig } from "vitest/config";

// Default unit-test run. Fork/integration tests live under test/fork and run via
// the separate vitest.fork.config.ts (npm run test:fork).
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "test/fork/**"],
  },
});
