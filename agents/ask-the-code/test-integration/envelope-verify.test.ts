import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DynamoConsumerRegistry,
  EnvelopeVerificationError,
  canonicalize,
  verifyEnvelope,
  type ConsumerRecord,
} from "@leanish/runtime";
import { LocalStackHarness } from "@leanish/runtime/testing";

import { createSigningKeyResolver } from "../src/signing-key-resolver.js";

/**
 * End-to-end test for ATC's envelope verification with real
 * `DynamoConsumerRegistry` + real `SSM Parameter Store`. Exercises the
 * `signingKey.kind: "ssm-parameter"` path that the unit tests cannot reach
 * because they mock the SDK out.
 *
 * Without this test, `ssm-parameter` was the canonical production auth path
 * with zero coverage — caught by the drift survey (Round 2026-05-24).
 *
 * `stack.start()` below throws `LocalStackUnavailableError` if LocalStack
 * isn't reachable — the integration gate fails loudly rather than
 * silently skipping.
 */
describe("agent-atc envelope verification against LocalStack", () => {
  const stack = new LocalStackHarness();

  beforeAll(async () => {
    await stack.start();
  });

  afterAll(async () => {
    await stack.stop();
  });

  it("verifies a real signed envelope when ConsumerRecord uses signingKey.kind='ssm-parameter'", async () => {
    // 1. Put the HMAC secret into SSM Parameter Store as a SecureString.
    const secretValue = "super-secret-hmac-key-from-ssm";
    const paramName = await stack.createSecureStringParameter(
      `/leanish/test/${stack.id}/atc-ui-secure`,
      secretValue,
    );

    // 2. Provision a DynamoDB-backed ConsumerRegistry + insert one consumer.
    const tableName = await stack.createConsumerRegistryTable();
    const registry = new DynamoConsumerRegistry({
      tableName,
      client: stack.dynamoClient(),
    });
    const record: ConsumerRecord = {
      consumerId: "atc-ui",
      signingKey: { kind: "ssm-parameter", name: paramName },
      allowedKinds: ["ask"],
    };
    await registry.put(record);

    // 3. Build a signed envelope using the same secret value.
    const envelope = makeSignedEnvelope({
      consumer: "atc-ui",
      kind: "ask",
      endUser: "u:42",
      payload: { question: "what does the verifier do?" },
      secret: secretValue,
    });

    // 4. Verify it using the production-shaped resolver path.
    const resolver = createSigningKeyResolver({
      ssmClient: stack.ssmClient(),
    });
    const verified = await verifyEnvelope({
      envelope,
      consumerRegistry: registry,
      resolveSigningKey: resolver,
    });

    expect(verified.consumer).toBe("atc-ui");
    expect(verified.kind).toBe("ask");
    expect(verified.payload["question"]).toBe("what does the verifier do?");
  });

  it("verifies a real signed envelope when ConsumerRecord uses signingKey.kind='literal' (no SSM call)", async () => {
    // Confirms backward compatibility with the existing literal-key path
    // that fixtures and tests use.
    const secretValue = "inline-hmac-key";
    const tableName = await stack.createConsumerRegistryTable();
    const registry = new DynamoConsumerRegistry({
      tableName,
      client: stack.dynamoClient(),
    });
    await registry.put({
      consumerId: "slack-bot",
      signingKey: {
        kind: "literal",
        base64: Buffer.from(secretValue, "utf8").toString("base64"),
      },
      allowedKinds: ["ask"],
    });

    const envelope = makeSignedEnvelope({
      consumer: "slack-bot",
      kind: "ask",
      endUser: "u:99",
      payload: { question: "literal path?" },
      secret: secretValue,
    });

    const resolver = createSigningKeyResolver({
      ssmClient: stack.ssmClient(),
    });
    const verified = await verifyEnvelope({
      envelope,
      consumerRegistry: registry,
      resolveSigningKey: resolver,
    });
    expect(verified.consumer).toBe("slack-bot");
  });

  it("rejects with bad-signature when the HMAC doesn't match", async () => {
    const realSecret = "real-secret";
    const wrongSecret = "wrong-secret";
    const paramName = await stack.createSecureStringParameter(
      `/leanish/test/${stack.id}/atc-ui-badsig`,
      realSecret,
    );

    const tableName = await stack.createConsumerRegistryTable();
    const registry = new DynamoConsumerRegistry({
      tableName,
      client: stack.dynamoClient(),
    });
    await registry.put({
      consumerId: "atc-ui",
      signingKey: { kind: "ssm-parameter", name: paramName },
      allowedKinds: ["ask"],
    });

    // Sign with the WRONG secret. Real secret in SM doesn't match.
    const envelope = makeSignedEnvelope({
      consumer: "atc-ui",
      kind: "ask",
      endUser: "u:42",
      payload: { question: "tampered" },
      secret: wrongSecret,
    });

    const resolver = createSigningKeyResolver({
      ssmClient: stack.ssmClient(),
    });
    await expect(
      verifyEnvelope({ envelope, consumerRegistry: registry, resolveSigningKey: resolver }),
    ).rejects.toMatchObject({
      name: "EnvelopeVerificationError",
      reason: "bad-signature",
    });
  });

  it("rejects with signing-key-unavailable when the ssm-parameter doesn't exist", async () => {
    const tableName = await stack.createConsumerRegistryTable();
    const registry = new DynamoConsumerRegistry({
      tableName,
      client: stack.dynamoClient(),
    });
    await registry.put({
      consumerId: "atc-ui",
      signingKey: {
        kind: "ssm-parameter",
        // Parameter name that won't exist in LocalStack.
        name: `/leanish/test/${stack.id}/nonexistent`,
      },
      allowedKinds: ["ask"],
    });

    const envelope = makeSignedEnvelope({
      consumer: "atc-ui",
      kind: "ask",
      endUser: "u:42",
      payload: { question: "no key" },
      secret: "doesnt-matter",
    });

    const resolver = createSigningKeyResolver({
      ssmClient: stack.ssmClient(),
    });

    let caught: unknown;
    try {
      await verifyEnvelope({ envelope, consumerRegistry: registry, resolveSigningKey: resolver });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvelopeVerificationError);
    expect((caught as EnvelopeVerificationError).reason).toBe("signing-key-unavailable");
  });

  it("rejects with kind-not-allowed when consumer publishes a disallowed kind", async () => {
    const secretValue = "hmac-key";
    const paramName = await stack.createSecureStringParameter(
      `/leanish/test/${stack.id}/atc-ui-kind`,
      secretValue,
    );
    const tableName = await stack.createConsumerRegistryTable();
    const registry = new DynamoConsumerRegistry({
      tableName,
      client: stack.dynamoClient(),
    });
    await registry.put({
      consumerId: "atc-ui",
      signingKey: { kind: "ssm-parameter", name: paramName },
      // Only `ask` allowed; envelope below tries `history-query`.
      allowedKinds: ["ask"],
    });

    const envelope = makeSignedEnvelope({
      consumer: "atc-ui",
      kind: "history-query",
      endUser: "u:42",
      payload: { conversationKey: "c1" },
      secret: secretValue,
    });

    const resolver = createSigningKeyResolver({
      ssmClient: stack.ssmClient(),
    });
    await expect(
      verifyEnvelope({ envelope, consumerRegistry: registry, resolveSigningKey: resolver }),
    ).rejects.toMatchObject({
      name: "EnvelopeVerificationError",
      reason: "kind-not-allowed",
    });
  });

  it("rejects with unknown-consumer when the consumerId isn't in the registry", async () => {
    const tableName = await stack.createConsumerRegistryTable();
    const registry = new DynamoConsumerRegistry({
      tableName,
      client: stack.dynamoClient(),
    });
    // No put — registry is empty.

    const envelope = makeSignedEnvelope({
      consumer: "ghost-bot",
      kind: "ask",
      endUser: "u:42",
      payload: { question: "anyone home?" },
      secret: "doesnt-matter",
    });

    const resolver = createSigningKeyResolver({
      ssmClient: stack.ssmClient(),
    });
    await expect(
      verifyEnvelope({ envelope, consumerRegistry: registry, resolveSigningKey: resolver }),
    ).rejects.toMatchObject({
      name: "EnvelopeVerificationError",
      reason: "unknown-consumer",
    });
  });

  it("caches SSM fetches within the TTL window", async () => {
    const secretValue = "ttl-cached-key";
    const paramName = await stack.createSecureStringParameter(
      `/leanish/test/${stack.id}/ttl-cached`,
      secretValue,
    );

    // Wrap the client to count GetParameter calls.
    const realClient = stack.ssmClient();
    let callCount = 0;
    const countingClient = new Proxy(realClient, {
      get(target, prop, receiver) {
        if (prop === "send") {
          return (cmd: unknown) => {
            callCount += 1;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
            return (target as unknown as { send: (c: unknown) => Promise<unknown> }).send(cmd);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const resolver = createSigningKeyResolver({
      ssmClient: countingClient,
      cacheTtlMs: 10_000,
    });

    const record: ConsumerRecord = {
      consumerId: "test",
      signingKey: { kind: "ssm-parameter", name: paramName },
      allowedKinds: ["ask"],
    };

    const first = await resolver(record);
    const second = await resolver(record);
    const third = await resolver(record);
    expect(first.toString("utf8")).toBe(secretValue);
    expect(second.toString("utf8")).toBe(secretValue);
    expect(third.toString("utf8")).toBe(secretValue);
    // Only one network round-trip despite three resolves.
    expect(callCount).toBe(1);
  });

  it("refetches after the TTL expires", async () => {
    const secretValue = "rotated-key-test";
    const paramName = await stack.createSecureStringParameter(
      `/leanish/test/${stack.id}/ttl-refetch`,
      secretValue,
    );

    const realClient = stack.ssmClient();
    let callCount = 0;
    const countingClient = new Proxy(realClient, {
      get(target, prop, receiver) {
        if (prop === "send") {
          return (cmd: unknown) => {
            callCount += 1;
            return (target as unknown as { send: (c: unknown) => Promise<unknown> }).send(cmd);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    let nowMs = 1_000;
    const resolver = createSigningKeyResolver({
      ssmClient: countingClient,
      cacheTtlMs: 500,
      clock: () => nowMs,
    });

    const record: ConsumerRecord = {
      consumerId: "test",
      signingKey: { kind: "ssm-parameter", name: paramName },
      allowedKinds: ["ask"],
    };

    await resolver(record);
    expect(callCount).toBe(1);

    nowMs += 200;
    await resolver(record);
    // Within TTL window.
    expect(callCount).toBe(1);

    nowMs += 1_000;
    await resolver(record);
    // Past TTL window — refetched.
    expect(callCount).toBe(2);
  });
});

/**
 * Mirror of the production sign logic from `agent-atc/src/dev-publish.ts`
 * (kept inline to avoid coupling this test to a non-public helper).
 */
function makeSignedEnvelope(args: {
  consumer: string;
  kind: string;
  endUser: string;
  payload: Record<string, unknown>;
  secret: string;
  conversationKey?: string;
  replyTo?: string;
}): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  const canonicalPayload = canonicalize(args.payload);
  const message =
    timestamp +
    "\n" +
    args.consumer +
    "\n" +
    args.endUser +
    "\n" +
    (args.conversationKey ?? "") +
    "\n" +
    canonicalPayload;
  const signature = createHmac("sha256", args.secret).update(message).digest("hex");
  return {
    kind: args.kind,
    requestId: `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    consumer: args.consumer,
    endUser: args.endUser,
    timestamp,
    payload: args.payload,
    signature,
    ...(args.conversationKey !== undefined ? { conversationKey: args.conversationKey } : {}),
    ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
  };
}
