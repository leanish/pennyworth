import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Source tests only — `npm run build` emits compiled copies into dist/,
    // which must not be re-run.
    include: ["test/**/*.test.ts"],
  },
});
