import { describe, expect, it } from "vitest";

import * as lambdaModule from "../src/lambda.js";

/**
 * Smoke test for the Lambda entry module. Does NOT call the handler
 * end-to-end — that would require live AWS resources or LocalStack. The
 * point is to confirm:
 *   - the module loads without throwing at import time
 *   - the public surface is shaped as expected (handler, factory, helper)
 *   - init fails fast when required env vars are missing
 */
describe("triage-it lambda module", () => {
  it("exposes the canonical Lambda surface", () => {
    expect(typeof lambdaModule.triageItLambdaHandler).toBe("function");
    expect(typeof lambdaModule.createTriageItLambdaHandler).toBe("function");
    expect(typeof lambdaModule.resolveSigningKeyFromRecord).toBe("function");
  });

  it("resolveSigningKeyFromRecord handles literal-base64 records", async () => {
    const key = await lambdaModule.resolveSigningKeyFromRecord({
      consumerId: "support-tooling",
      signingKey: { kind: "literal", base64: Buffer.from("hello").toString("base64") },
      allowedKinds: ["triage"],
    });
    expect(key.toString("utf8")).toBe("hello");
  });

  it("resolveSigningKeyFromRecord (unit-test path) rejects ssm-parameter — production uses createSigningKeyResolver", async () => {
    await expect(
      lambdaModule.resolveSigningKeyFromRecord({
        consumerId: "support-tooling",
        signingKey: {
          kind: "ssm-parameter",
          name: "/leanish/agents/triage-it/signing-keys/support-tooling",
        },
        allowedKinds: ["triage"],
      }),
    ).rejects.toThrowError(/only supports signingKey\.kind='literal'/);
  });

  it("createTriageItLambdaHandler fails fast when required env vars are missing", async () => {
    // Make sure no leftover env vars from the host shell mask the test.
    const requiredVars = [
      "IDEMPOTENCY_TABLE_NAME",
      "CONSUMER_REGISTRY_TABLE_NAME",
      "CATALOG_BUCKET",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const v of requiredVars) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    try {
      await expect(lambdaModule.createTriageItLambdaHandler()).rejects.toThrowError(
        /IDEMPOTENCY_TABLE_NAME/,
      );
    } finally {
      for (const v of requiredVars) {
        if (saved[v] !== undefined) process.env[v] = saved[v];
      }
    }
  });
});
