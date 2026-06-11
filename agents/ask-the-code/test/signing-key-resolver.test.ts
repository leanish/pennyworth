import { describe, expect, it, vi } from "vitest";

import {
  GetParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

import { EnvelopeVerificationError, type ConsumerRecord } from "@leanish/runtime";

import { createSigningKeyResolver } from "../src/signing-key-resolver.js";

/**
 * Unit-level coverage for `createSigningKeyResolver`. The integration
 * suite (`test-integration/envelope-verify.test.ts`) exercises the same
 * resolver against real LocalStack SSM Parameter Store + a real envelope
 * `verifyEnvelope` call — those tests skip without Docker. These tests
 * give us offline coverage of the resolver shape (cache, error mapping)
 * via an `SSMClient.send` mock.
 */
describe("createSigningKeyResolver", () => {
  function mockSsmClient(send: (cmd: GetParameterCommand) => Promise<unknown>): SSMClient {
    return { send } as unknown as SSMClient;
  }

  const PARAM_NAME = "/leanish/agents/ask-the-code/signing-keys/atc-ui";

  it("resolves a literal key without ever calling SSM", async () => {
    const send = vi.fn();
    const resolver = createSigningKeyResolver({
      ssmClient: mockSsmClient(send as unknown as (cmd: GetParameterCommand) => Promise<unknown>),
    });

    const record: ConsumerRecord = {
      consumerId: "atc-ui",
      signingKey: {
        kind: "literal",
        base64: Buffer.from("hello", "utf8").toString("base64"),
      },
      allowedKinds: ["ask"],
    };
    const key = await resolver(record);
    expect(key.toString("utf8")).toBe("hello");
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves an ssm-parameter by fetching Parameter.Value", async () => {
    const send = vi.fn(async () => ({ Parameter: { Value: "fetched-from-ssm" } }));
    const resolver = createSigningKeyResolver({
      ssmClient: mockSsmClient(send),
    });

    const key = await resolver({
      consumerId: "atc-ui",
      signingKey: { kind: "ssm-parameter", name: PARAM_NAME },
      allowedKinds: ["ask"],
    });
    expect(key.toString("utf8")).toBe("fetched-from-ssm");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("caches ssm-parameter fetches within the TTL window", async () => {
    const send = vi.fn(async () => ({ Parameter: { Value: "v1" } }));
    let nowMs = 1_000;
    const resolver = createSigningKeyResolver({
      ssmClient: mockSsmClient(send),
      cacheTtlMs: 5_000,
      clock: () => nowMs,
    });
    const record: ConsumerRecord = {
      consumerId: "atc-ui",
      signingKey: { kind: "ssm-parameter", name: PARAM_NAME },
      allowedKinds: ["ask"],
    };

    await resolver(record);
    expect(send).toHaveBeenCalledTimes(1);

    // Within TTL.
    nowMs += 1_000;
    await resolver(record);
    expect(send).toHaveBeenCalledTimes(1);

    // Past TTL.
    nowMs += 10_000;
    await resolver(record);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent fetches on the same parameter", async () => {
    let resolveFetch: (v: { Parameter: { Value: string } }) => void = () => undefined;
    const fetchPromise = new Promise<{ Parameter: { Value: string } }>((resolve) => {
      resolveFetch = resolve;
    });
    const send = vi.fn(async () => fetchPromise);
    const resolver = createSigningKeyResolver({
      ssmClient: mockSsmClient(send),
    });
    const record: ConsumerRecord = {
      consumerId: "atc-ui",
      signingKey: { kind: "ssm-parameter", name: PARAM_NAME },
      allowedKinds: ["ask"],
    };
    // Fire 3 resolves before the fetch resolves; they should all wait on
    // the same in-flight Promise.
    const p1 = resolver(record);
    const p2 = resolver(record);
    const p3 = resolver(record);

    expect(send).toHaveBeenCalledTimes(1);
    resolveFetch({ Parameter: { Value: "v1" } });

    const [k1, k2, k3] = await Promise.all([p1, p2, p3]);
    expect(k1.toString("utf8")).toBe("v1");
    expect(k2.toString("utf8")).toBe("v1");
    expect(k3.toString("utf8")).toBe("v1");
  });

  it("maps SSM errors to EnvelopeVerificationError('signing-key-unavailable')", async () => {
    const send = vi.fn(async () => {
      throw new Error("ParameterNotFound: the parameter could not be found.");
    });
    const resolver = createSigningKeyResolver({
      ssmClient: mockSsmClient(send),
    });

    const missingParam = "/leanish/agents/ask-the-code/signing-keys/missing";
    let caught: unknown;
    try {
      await resolver({
        consumerId: "atc-ui",
        signingKey: { kind: "ssm-parameter", name: missingParam },
        allowedKinds: ["ask"],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvelopeVerificationError);
    expect((caught as EnvelopeVerificationError).reason).toBe("signing-key-unavailable");
    expect((caught as Error).message).toContain("atc-ui");
    expect((caught as Error).message).toContain(missingParam);
  });

  it("rejects with signing-key-unavailable when Parameter.Value is absent", async () => {
    const send = vi.fn(async () => ({ Parameter: {} }));
    const resolver = createSigningKeyResolver({
      ssmClient: mockSsmClient(send),
    });
    await expect(
      resolver({
        consumerId: "atc-ui",
        signingKey: { kind: "ssm-parameter", name: "/leanish/agents/ask-the-code/signing-keys/empty" },
        allowedKinds: ["ask"],
      }),
    ).rejects.toMatchObject({
      name: "EnvelopeVerificationError",
      reason: "signing-key-unavailable",
    });
  });

  it("clears the in-flight slot after a failed fetch so retries don't await a rejected promise", async () => {
    let callCount = 0;
    const send = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("transient");
      return { Parameter: { Value: "recovered" } };
    });
    const resolver = createSigningKeyResolver({
      ssmClient: mockSsmClient(send),
    });
    const record: ConsumerRecord = {
      consumerId: "atc-ui",
      signingKey: { kind: "ssm-parameter", name: PARAM_NAME },
      allowedKinds: ["ask"],
    };

    await expect(resolver(record)).rejects.toBeInstanceOf(EnvelopeVerificationError);
    // Second attempt — should NOT be coalesced with the prior failed in-flight Promise.
    const key = await resolver(record);
    expect(key.toString("utf8")).toBe("recovered");
  });
});
