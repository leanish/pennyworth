import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { MemoryConsumerRegistry } from "../../src/consumer-registry/memory.js";
import { canonicalize } from "../../src/envelope/canonical.js";
import {
  EnvelopeVerificationError,
} from "../../src/errors.js";
import { envelopeToRuntimeMessage } from "../../src/envelope/to-runtime-message.js";
import { verifyEnvelope } from "../../src/envelope/verify.js";

function signEnvelope(env: {
  kind: string;
  consumer: string;
  endUser: string;
  conversationKey?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}, keyBytes: Buffer): string {
  const message =
    env.timestamp +
    "\n" +
    env.consumer +
    "\n" +
    env.endUser +
    "\n" +
    (env.conversationKey ?? "") +
    "\n" +
    canonicalize(env.payload);
  return createHmac("sha256", keyBytes).update(message).digest("hex");
}

describe("verifyEnvelope", () => {
  const keyBytes = randomBytes(32);
  const keyBase64 = keyBytes.toString("base64");

  function makeRegistry(allowedKinds: string[] = ["ask"]): MemoryConsumerRegistry {
    return new MemoryConsumerRegistry([
      {
        consumerId: "atc-ui",
        signingKey: { kind: "literal", base64: keyBase64 },
        allowedKinds,
      },
    ]);
  }

  function makeValidEnvelope(): {
    kind: string;
    requestId: string;
    consumer: string;
    endUser: string;
    timestamp: string;
    payload: Record<string, unknown>;
    signature: string;
  } {
    const partial = {
      kind: "ask",
      requestId: "req-1",
      consumer: "atc-ui",
      endUser: "github:U1",
      timestamp: new Date().toISOString(),
      payload: { question: "What does auth do?" },
    };
    return { ...partial, signature: signEnvelope(partial, keyBytes) };
  }

  it("accepts a well-formed signed envelope", async () => {
    const verified = await verifyEnvelope({
      envelope: makeValidEnvelope(),
      consumerRegistry: makeRegistry(),
    });
    expect(verified.consumer).toBe("atc-ui");
    expect(verified.payload["question"]).toBe("What does auth do?");
  });

  it("rejects an unknown consumer with reason='unknown-consumer'", async () => {
    const env = makeValidEnvelope();
    env.consumer = "stranger";
    env.signature = signEnvelope(env, keyBytes);
    try {
      await verifyEnvelope({ envelope: env, consumerRegistry: makeRegistry() });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeVerificationError);
      expect((err as EnvelopeVerificationError).reason).toBe("unknown-consumer");
    }
  });

  it("rejects a kind the consumer is not allowed to publish with reason='kind-not-allowed'", async () => {
    const partial = {
      kind: "cancel",
      requestId: "req-1",
      consumer: "atc-ui",
      endUser: "github:U1",
      timestamp: new Date().toISOString(),
      payload: {},
    };
    const env = { ...partial, signature: signEnvelope(partial, keyBytes) };
    try {
      await verifyEnvelope({ envelope: env, consumerRegistry: makeRegistry(["ask"]) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeVerificationError);
      expect((err as EnvelopeVerificationError).reason).toBe("kind-not-allowed");
    }
  });

  it("rejects ssm-parameter signing keys with no resolver, typed as signing-key-unavailable", async () => {
    const registry = new MemoryConsumerRegistry([
      {
        consumerId: "atc-ui",
        signingKey: { kind: "ssm-parameter", name: "/leanish/agents/atc/signing-keys/atc-ui" },
        allowedKinds: ["ask"],
      },
    ]);
    const env = makeValidEnvelope();
    try {
      await verifyEnvelope({ envelope: env, consumerRegistry: registry });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeVerificationError);
      expect((err as EnvelopeVerificationError).reason).toBe("signing-key-unavailable");
    }
  });

  it("rejects a tampered signature", async () => {
    const env = makeValidEnvelope();
    env.signature = "0".repeat(env.signature.length);
    await expect(
      verifyEnvelope({ envelope: env, consumerRegistry: makeRegistry() }),
    ).rejects.toBeInstanceOf(EnvelopeVerificationError);
  });

  it("rejects a timestamp outside the clock-skew window with reason='timestamp-outside-skew'", async () => {
    const partial = {
      kind: "ask",
      requestId: "req-1",
      consumer: "atc-ui",
      endUser: "github:U1",
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      payload: { q: 1 },
    };
    const env = { ...partial, signature: signEnvelope(partial, keyBytes) };
    try {
      await verifyEnvelope({ envelope: env, consumerRegistry: makeRegistry() });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeVerificationError);
      expect((err as EnvelopeVerificationError).reason).toBe("timestamp-outside-skew");
    }
  });

  it("rejects key-reordered payloads only when the signature was over a different order", async () => {
    // The verifier canonicalises before signing/verifying, so re-ordering
    // the parsed payload object should NOT invalidate the signature.
    const env = makeValidEnvelope();
    env.payload = { a: 1, z: 2 };
    env.signature = signEnvelope(env, keyBytes);
    const reordered = { ...env, payload: { z: 2, a: 1 } };
    const verified = await verifyEnvelope({
      envelope: reordered,
      consumerRegistry: makeRegistry(),
    });
    expect(verified.payload["a"]).toBe(1);
  });
});

describe("envelopeToRuntimeMessage", () => {
  it("maps a verified envelope to the nested RuntimeMessage shape", () => {
    const verified = {
      kind: "ask",
      requestId: "biz-1",
      consumer: "atc-ui",
      endUser: "github:U1",
      timestamp: "2026-05-23T00:00:00.000Z",
      payload: { question: "X?", projectIds: ["a/b"] },
      signature: "sig",
      replyTo: "arn:aws:sqs:us-east-1:000000000000:replies",
    } as const;
    const msg = envelopeToRuntimeMessage(verified, {
      sqsMessageId: "sqs-1",
      receivedAt: "2026-05-23T00:00:01.000Z",
    });
    expect(msg.stage).toBe("init");
    expect(msg.metadata.sourceTrigger).toBe("consumer");
    expect(msg.metadata.requestId).toBe("sqs-1");
    expect(msg.payload.envelope.requestId).toBe("biz-1");
    expect(msg.payload.envelope.replyTo).toBe(verified.replyTo);
    expect(msg.payload.request).toEqual({ question: "X?", projectIds: ["a/b"] });
  });
});
