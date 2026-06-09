import { createHmac, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MemoryConsumerRegistry } from "../../src/consumer-registry/memory.js";
import { canonicalize } from "../../src/envelope/canonical.js";
import { createSqsLambdaShim } from "../../src/aws-mode/sqs-lambda-shim.js";
import type { SqsEvent } from "../../src/aws-mode/sqs-event.js";
import { ConsoleLogger } from "../../src/logger/console-logger.js";
import { defineAgent } from "../../src/define-agent.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/memory.js";
import type { AgentDescriptor } from "../../src/types/descriptor.js";
import type { Runtime } from "../../src/types/runtime.js";

const QUIET_LOGGER = new ConsoleLogger({ minLevel: "error" });

const DESCRIPTOR: AgentDescriptor = {
  identifier: "atc",
  compute: "lambda",
  triggers: [{ type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: true }],
  stages: ["init"],
  codingAgent: "claude-code",
  model: "m",
  skills: { entrypoints: ["ask"], support: [] },
  needs: [],
  extensions: {},
};

const UNSIGNED_DESCRIPTOR: AgentDescriptor = {
  ...DESCRIPTOR,
  triggers: [{ type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: false }],
};

/** An envelope-shaped body with no `signature` field (the `signedEnvelope:false` path). */
function unsignedRecord(
  messageId: string,
  envelope: Record<string, unknown>,
): { messageId: string; body: string } {
  return { messageId, body: JSON.stringify(envelope) };
}

function signedRecord(
  messageId: string,
  payload: Record<string, unknown>,
  key: Buffer,
  now = new Date(),
): { messageId: string; body: string } {
  const partial = {
    kind: "ask",
    requestId: messageId,
    consumer: "atc-ui",
    endUser: "github:U1",
    timestamp: now.toISOString(),
    payload,
  };
  const message =
    partial.timestamp +
    "\n" +
    partial.consumer +
    "\n" +
    partial.endUser +
    "\n" +
    "" +
    "\n" +
    canonicalize(partial.payload);
  const signature = createHmac("sha256", key).update(message).digest("hex");
  return {
    messageId,
    body: JSON.stringify({ ...partial, signature }),
  };
}

describe("createSqsLambdaShim", () => {
  it("verifies → claims → dispatches → completes on success", async () => {
    const key = randomBytes(32);
    const registry = new MemoryConsumerRegistry([
      {
        consumerId: "atc-ui",
        signingKey: { kind: "literal", base64: key.toString("base64") },
        allowedKinds: ["ask"],
      },
    ]);
    const idempotency = new MemoryIdempotencyStore();
    const handle = vi.fn(async () => {});
    const agent = defineAgent({ identifier: "atc", handle });

    const shim = createSqsLambdaShim({
      agent,
      descriptor: DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      consumerRegistry: registry,
      logger: QUIET_LOGGER,
    });

    const event: SqsEvent = {
      Records: [signedRecord("msg-1", { question: "X?" }, key)],
    };
    const result = await shim(event);
    expect(result.batchItemFailures).toHaveLength(0);
    expect(handle).toHaveBeenCalledOnce();
    expect(idempotency.inspect("msg-1")).toMatchObject({ status: "completed" });
  });

  it("accepts an unsigned consumer envelope (signedEnvelope:false) with no signature", async () => {
    const idempotency = new MemoryIdempotencyStore();
    const handle = vi.fn(async () => {});
    const agent = defineAgent({ identifier: "atc", handle });

    // No consumerRegistry: unsigned triggers don't require one.
    const shim = createSqsLambdaShim({
      agent,
      descriptor: UNSIGNED_DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      logger: QUIET_LOGGER,
    });

    const record = unsignedRecord("msg-unsigned", {
      kind: "ask",
      requestId: "msg-unsigned",
      consumer: "atc-ui",
      endUser: "github:U1",
      timestamp: new Date().toISOString(),
      payload: { question: "X?" },
      // no `signature`
    });
    const result = await shim({ Records: [record] });

    expect(result.batchItemFailures).toHaveLength(0);
    expect(result.results[0]?.status).toBe("handled");
    expect(handle).toHaveBeenCalledOnce();
    expect(idempotency.inspect("msg-unsigned")).toMatchObject({ status: "completed" });
  });

  it("rejects an unsigned consumer envelope that is structurally malformed", async () => {
    const idempotency = new MemoryIdempotencyStore();
    const handle = vi.fn(async () => {});
    const agent = defineAgent({ identifier: "atc", handle });

    const shim = createSqsLambdaShim({
      agent,
      descriptor: UNSIGNED_DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      logger: QUIET_LOGGER,
    });

    // Missing `kind` — shape validation still runs even without a signature.
    const record = unsignedRecord("msg-unsigned-bad", {
      requestId: "msg-unsigned-bad",
      consumer: "atc-ui",
      endUser: "github:U1",
      timestamp: new Date().toISOString(),
      payload: { question: "X?" },
    });
    const result = await shim({ Records: [record] });

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-unsigned-bad" }]);
    expect(result.results[0]?.status).toBe("envelope-rejected");
    expect(handle).not.toHaveBeenCalled();
  });

  it("ACKs (no failure) when the same MessageId has already completed", async () => {
    const key = randomBytes(32);
    const registry = new MemoryConsumerRegistry([
      {
        consumerId: "atc-ui",
        signingKey: { kind: "literal", base64: key.toString("base64") },
        allowedKinds: ["ask"],
      },
    ]);
    const idempotency = new MemoryIdempotencyStore();
    const handle = vi.fn(async () => {});
    const agent = defineAgent({ identifier: "atc", handle });

    const shim = createSqsLambdaShim({
      agent,
      descriptor: DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      consumerRegistry: registry,
      logger: QUIET_LOGGER,
    });

    const record = signedRecord("msg-dup", { question: "X?" }, key);
    await shim({ Records: [record] });
    const result = await shim({ Records: [record] }); // duplicate
    expect(result.batchItemFailures).toHaveLength(0);
    expect(handle).toHaveBeenCalledOnce(); // still only ran once
  });

  it("reports envelope-verification failures as batchItemFailures", async () => {
    const key = randomBytes(32);
    const registry = new MemoryConsumerRegistry([
      {
        consumerId: "atc-ui",
        signingKey: { kind: "literal", base64: key.toString("base64") },
        allowedKinds: ["ask"],
      },
    ]);
    const idempotency = new MemoryIdempotencyStore();
    const handle = vi.fn(async () => {});
    const agent = defineAgent({ identifier: "atc", handle });

    const shim = createSqsLambdaShim({
      agent,
      descriptor: DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      consumerRegistry: registry,
      logger: QUIET_LOGGER,
    });

    const tampered = signedRecord("msg-tamper", { question: "X?" }, key);
    const body = JSON.parse(tampered.body);
    body.signature = "0".repeat(body.signature.length);
    const result = await shim({
      Records: [{ messageId: tampered.messageId, body: JSON.stringify(body) }],
    });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-tamper" }]);
    expect(handle).not.toHaveBeenCalled();
  });

  it("expires the claim and reports failure when the handler throws", async () => {
    const key = randomBytes(32);
    const registry = new MemoryConsumerRegistry([
      {
        consumerId: "atc-ui",
        signingKey: { kind: "literal", base64: key.toString("base64") },
        allowedKinds: ["ask"],
      },
    ]);
    const idempotency = new MemoryIdempotencyStore();
    const handle = vi.fn(async () => {
      throw new Error("boom");
    });
    const agent = defineAgent({ identifier: "atc", handle });

    const shim = createSqsLambdaShim({
      agent,
      descriptor: DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      consumerRegistry: registry,
      logger: QUIET_LOGGER,
    });

    const result = await shim({
      Records: [signedRecord("msg-throw", { question: "X?" }, key)],
    });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-throw" }]);
    const rec = idempotency.inspect("msg-throw");
    expect(rec?.status).toBe("in-flight");
    // expire() set claimUntil to "now" so a redelivery reclaims on the first try.
    expect(rec?.status === "in-flight" && rec.claimUntil).toBeDefined();
  });

  it("returns handled-stale-complete and ACKs when complete() races a reclaim", async () => {
    const key = randomBytes(32);
    const registry = new MemoryConsumerRegistry([
      {
        consumerId: "atc-ui",
        signingKey: { kind: "literal", base64: key.toString("base64") },
        allowedKinds: ["ask"],
      },
    ]);
    // Stub store: claim succeeds, complete reports stale.
    const idempotency = {
      claim: vi.fn(async () => ({
        status: "claimed" as const,
        record: {
          status: "in-flight" as const,
          startedAt: "2026-05-23T00:00:00.000Z",
          claimUntil: "2026-05-23T00:16:00.000Z",
          agent: "atc",
        },
      })),
      complete: vi.fn(async () => ({ status: "stale" as const })),
      expire: vi.fn(async () => ({ status: "ok" as const })),
    };
    const handle = vi.fn(async () => {});
    const agent = defineAgent({ identifier: "atc", handle });

    const shim = createSqsLambdaShim({
      agent,
      descriptor: DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      consumerRegistry: registry,
      logger: QUIET_LOGGER,
    });

    const event: SqsEvent = {
      Records: [signedRecord("msg-stale", { question: "X?" }, key)],
    };
    const result = await shim(event);
    expect(result.batchItemFailures).toHaveLength(0);
    expect(result.results[0]?.status).toBe("handled-stale-complete");
    expect(idempotency.complete).toHaveBeenCalledWith(
      "msg-stale",
      "2026-05-23T00:16:00.000Z",
      expect.any(String),
    );
    expect(handle).toHaveBeenCalledOnce();
  });

  it("ACKs handled-complete-write-failed when complete() throws after a successful handler (no re-run)", async () => {
    const key = randomBytes(32);
    const registry = new MemoryConsumerRegistry([
      {
        consumerId: "atc-ui",
        signingKey: { kind: "literal", base64: key.toString("base64") },
        allowedKinds: ["ask"],
      },
    ]);
    // claim succeeds; the handler succeeds; the completed-marker write THROWS
    // (transient DynamoDB error, post-SDK-retry). The work + reply already
    // happened, so the shim must ACK + warn — NOT expire and re-run.
    const idempotency = {
      claim: vi.fn(async () => ({
        status: "claimed" as const,
        record: {
          status: "in-flight" as const,
          startedAt: "2026-05-23T00:00:00.000Z",
          claimUntil: "2026-05-23T00:16:00.000Z",
          agent: "atc",
        },
      })),
      complete: vi.fn(async () => {
        throw new Error("dynamo 500 on PutItem");
      }),
      expire: vi.fn(async () => ({ status: "ok" as const })),
    };
    const handle = vi.fn(async () => {});
    const agent = defineAgent({ identifier: "atc", handle });

    const shim = createSqsLambdaShim({
      agent,
      descriptor: DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      consumerRegistry: registry,
      logger: QUIET_LOGGER,
    });

    const result = await shim({
      Records: [signedRecord("msg-complete-throw", { question: "X?" }, key)],
    });

    expect(result.batchItemFailures).toHaveLength(0); // ACK — message deleted, no retry
    expect(result.results[0]?.status).toBe("handled-complete-write-failed");
    expect(handle).toHaveBeenCalledOnce(); // work ran exactly once
    expect(idempotency.expire).not.toHaveBeenCalled(); // crucially: NOT expired → no re-run
  });

  it("returns a richer per-record status alongside batchItemFailures", async () => {
    const key = randomBytes(32);
    const registry = new MemoryConsumerRegistry([
      {
        consumerId: "atc-ui",
        signingKey: { kind: "literal", base64: key.toString("base64") },
        allowedKinds: ["ask"],
      },
    ]);
    const idempotency = new MemoryIdempotencyStore();
    // Handler succeeds for "good", throws for "boom" via payload sniffing.
    const handle = vi.fn(async (message: { payload: unknown }) => {
      const payload = message.payload as { request?: { question?: string } };
      if (payload.request?.question === "boom") throw new Error("kaboom");
    });
    const agent = defineAgent({ identifier: "atc", handle });

    const shim = createSqsLambdaShim({
      agent,
      descriptor: DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      consumerRegistry: registry,
      logger: QUIET_LOGGER,
    });

    // Pre-seed a completed marker so a duplicate-completed record shows up.
    const dupRecord = signedRecord("msg-batch-dup", { question: "X?" }, key);
    await shim({ Records: [dupRecord] });

    // Build a mixed batch: a fresh good, a fresh failure, a duplicate of the prior,
    // and a tampered envelope.
    const good = signedRecord("msg-batch-good", { question: "X?" }, key);
    const bad = signedRecord("msg-batch-bad", { question: "boom" }, key);
    const tampered = (() => {
      const r = signedRecord("msg-batch-tamper", { question: "X?" }, key);
      const body = JSON.parse(r.body);
      body.signature = "0".repeat(body.signature.length);
      return { messageId: r.messageId, body: JSON.stringify(body) };
    })();
    const parseFail = { messageId: "msg-batch-parsefail", body: "not-json{" };

    const result = await shim({
      Records: [good, bad, dupRecord, tampered, parseFail],
    });

    // batchItemFailures contains everything except handled + duplicate-completed.
    expect(new Set(result.batchItemFailures.map((f) => f.itemIdentifier))).toEqual(
      new Set([
        "msg-batch-bad",
        "msg-batch-tamper",
        "msg-batch-parsefail",
      ]),
    );

    // results carries one entry per input record, in order, with typed status.
    expect(result.results.map((r) => [r.messageId, r.status])).toEqual([
      ["msg-batch-good", "handled"],
      ["msg-batch-bad", "handler-failed"],
      ["msg-batch-dup", "duplicate-completed"],
      ["msg-batch-tamper", "envelope-rejected"],
      ["msg-batch-parsefail", "envelope-parse-failed"],
    ]);
    // Failure variants carry an error message.
    const errorMap = Object.fromEntries(
      result.results.map((r) => [r.messageId, r.error]),
    );
    expect(errorMap["msg-batch-bad"]).toBe("kaboom");
    expect(errorMap["msg-batch-tamper"]).toMatch(/signature/);
    expect(errorMap["msg-batch-parsefail"]).toMatch(/JSON/i);
  });
});
