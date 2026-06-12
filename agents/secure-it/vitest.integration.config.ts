import { defineConfig } from "vitest/config";

/**
 * LocalStack-backed integration tests. Mirrors ask-the-code's matching
 * config (see agent-runtime's for the original rationale): serialized
 * files (each test file mutates process.env via the harness), generous
 * timeouts for real AWS round-trips, fail-loud when LocalStack is down
 * (`LocalStackHarness.start()` throws — no silent skips).
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
