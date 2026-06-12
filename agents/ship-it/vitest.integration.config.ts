import { defineConfig } from "vitest/config";

/**
 * LocalStack-backed integration tests. See agent-runtime's matching
 * config for the rationale.
 *
 *   npm run test:integration
 */
export default defineConfig({
  test: {
    include: ["test-integration/**/*.test.ts"],
    environment: "node",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
