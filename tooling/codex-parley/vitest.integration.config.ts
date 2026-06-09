import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test-integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
