import { defineConfig } from "vitest/config";

/**
 * LocalStack-backed integration tests for catalogit. Exercises the S3
 * publish path + S3Catalog read path against a real S3 backend running
 * inside `docker compose up -d localstack` (port 4566 by default). Tests
 * skip cleanly when LocalStack isn't reachable.
 *
 *   npm run test:integration
 *
 * Lives in `test-integration/` (sibling of `test/`) to keep `npm test`
 * (the fast unit gate) free of Docker dependencies.
 */
export default defineConfig({
  test: {
    include: ["test-integration/**/*.test.ts"],
    environment: "node",
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
    // Sequential file execution by default — LocalStack handles concurrent
    // requests fine, but verbose interleaved logs across parallel workers
    // make integration-test debugging painful. Workers within a file still
    // run tests in parallel.
    fileParallelism: false,
    // Integration tests legitimately take longer than units (bucket
    // creation + multi-step round-trips against the LocalStack container).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
