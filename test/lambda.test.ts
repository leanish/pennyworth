import { describe, expect, it } from "vitest";

import * as lambdaModule from "../src/lambda.js";

/**
 * Smoke test for the Lambda entry module. Does NOT call `atcLambdaHandler`
 * end-to-end — that would require live AWS resources or LocalStack. The
 * point is to confirm:
 *   - the module loads without throwing at import time
 *   - the public surface is shaped as expected (handler, factory, helper)
 *   - the cached handler short-circuits init when env vars are missing
 *
 * The full verify→claim→dispatch path is exercised by
 * `agent-runtime/test/unit/sqs-lambda-shim.test.ts`; this test just
 * proves the wiring composes.
 */
describe("agent-atc lambda module", () => {
  it("exposes the canonical Lambda surface", () => {
    expect(typeof lambdaModule.atcLambdaHandler).toBe("function");
    expect(typeof lambdaModule.createAtcLambdaHandler).toBe("function");
    expect(typeof lambdaModule.resolveSigningKeyFromRecord).toBe("function");
  });

  it("resolveSigningKeyFromRecord handles literal-base64 records", async () => {
    const key = await lambdaModule.resolveSigningKeyFromRecord({
      consumerId: "atc-ui",
      signingKey: { kind: "literal", base64: Buffer.from("hello").toString("base64") },
      allowedKinds: ["ask"],
    });
    expect(key.toString("utf8")).toBe("hello");
  });

  it("resolveSigningKeyFromRecord (unit-test path) rejects ssm-parameter — production uses createSigningKeyResolver", async () => {
    // The unit-test resolver only handles `literal`; the production
    // resolver wired into the Lambda lives in `signing-key-resolver.ts`
    // and handles both `literal` and `ssm-parameter` via the real SSM
    // client (exercised by the LocalStack integration test).
    await expect(
      lambdaModule.resolveSigningKeyFromRecord({
        consumerId: "atc-ui",
        signingKey: { kind: "ssm-parameter", name: "/leanish/agents/atc/signing-keys/atc-ui" },
        allowedKinds: ["ask"],
      }),
    ).rejects.toThrowError(/only supports signingKey\.kind='literal'/);
  });

  it("createAtcLambdaHandler fails fast when required env vars are missing", async () => {
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
      await expect(lambdaModule.createAtcLambdaHandler()).rejects.toThrowError(
        /IDEMPOTENCY_TABLE_NAME/,
      );
    } finally {
      for (const v of requiredVars) {
        if (saved[v] !== undefined) process.env[v] = saved[v];
      }
    }
  });
});
