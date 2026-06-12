import { describe, expect, it } from "vitest";

import * as lambdaModule from "../src/lambda.js";

/**
 * Smoke test for the Lambda entry module. Does NOT call the handler
 * end-to-end — that would need live AWS resources. The point is to
 * confirm the module loads, exposes the canonical surface, and fails
 * fast (with an actionable message) when required env vars are missing.
 * The verify→claim→dispatch path itself is covered by the runtime's
 * sqs-lambda-shim tests; the stage logic by `handler.test.ts`.
 */
describe("agent-bump-it lambda module", () => {
  it("exposes the canonical Lambda surface", () => {
    expect(typeof lambdaModule.bumpItLambdaHandler).toBe("function");
    expect(typeof lambdaModule.createBumpItLambdaHandler).toBe("function");
  });

  it("createBumpItLambdaHandler fails fast when required env vars are missing", async () => {
    const requiredVars = [
      "IDEMPOTENCY_TABLE_NAME",
      "CATALOG_BUCKET",
      "SELF_QUEUE_URL",
      "SELF_QUEUE_ARN",
      "SCHEDULE_GROUP_NAME",
      "SCHEDULER_ROLE_ARN",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const v of requiredVars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    try {
      // The first missing var (checked in declaration order) is reported.
      await expect(lambdaModule.createBumpItLambdaHandler()).rejects.toThrowError(
        /IDEMPOTENCY_TABLE_NAME/,
      );
    } finally {
      for (const v of requiredVars) {
        if (saved[v] !== undefined) process.env[v] = saved[v];
      }
    }
  });
});
