import { defineConfig } from "vitest/config";

// Fork/integration tests hit a live or anvil-forked RPC — longer timeout, run on
// demand (npm run test:fork). They self-skip unless SDK_FORK_RPC is set.
export default defineConfig({
  test: {
    include: ["test/fork/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
