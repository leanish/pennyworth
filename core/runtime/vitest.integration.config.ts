import { defineConfig } from "vitest/config";

/**
 * LocalStack-backed integration tests. Boots clients against a running
 * `docker compose up -d localstack` (port 4566 by default). Tests are
 * skipped cleanly when LocalStack isn't reachable.
 *
 *   npm run test:integration
 *
 * Tests share the same TypeScript baseline as `test/` but live in
 * `test-integration/` to keep `npm test` (the fast unit gate) free of
 * Docker dependencies.
 */
export default defineConfig({
  test: {
    include: ["test-integration/**/*.test.ts"],
    environment: "node",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    // Sequential file execution by default — LocalStack handles concurrent
    // service requests fine, but verbose interleaved logs across parallel
    // workers make integration-test debugging painful. Workers within a
    // file still run tests in parallel.
    fileParallelism: false,
    // Integration tests legitimately take longer than units (DDB
    // table-creation alone is ~1s on LocalStack).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
