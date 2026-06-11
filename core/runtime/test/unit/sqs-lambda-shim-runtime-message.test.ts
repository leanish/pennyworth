import { describe, expect, it, vi } from "vitest";

import { createSqsLambdaShim } from "../../src/aws-mode/sqs-lambda-shim.js";
import type { SqsEvent } from "../../src/aws-mode/sqs-event.js";
import { ConsoleLogger } from "../../src/logger/console-logger.js";
import { defineAgent } from "../../src/define-agent.js";
import { MemoryConsumerRegistry } from "../../src/consumer-registry/memory.js";
import { MemoryIdempotencyStore } from "../../src/idempotency/memory.js";
import type { AgentDescriptor } from "../../src/types/descriptor.js";
import type { AgentPayloadBase } from "../../src/types/execution-override.js";
import type { Runtime } from "../../src/types/runtime.js";
import type { RuntimeMessage } from "../../src/types/runtime-message.js";

interface TestPayload extends AgentPayloadBase {
  readonly projectId?: string;
}

const QUIET_LOGGER = new ConsoleLogger({ minLevel: "error" });

/** Phase-2 style scheduler-driven agent (no consumer trigger at all). */
const SCHEDULER_DESCRIPTOR: AgentDescriptor = {
  identifier: "secure-it",
  compute: "lambda",
  triggers: [{ type: "scheduler", queueArnRef: "q", dlqArnRef: "dlq" }] as never,
  stages: ["init", "breakdown", "revisit"],
  codingAgent: "claude-code",
  model: "m",
  skills: { entrypoints: ["secure-it"], support: [] },
  needs: [],
  extensions: {},
};

/** Mixed agent: signed consumer trigger + self-published revisit stage. */
const MIXED_DESCRIPTOR: AgentDescriptor = {
  identifier: "ship-it",
  compute: "lambda",
  triggers: [{ type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: true }],
  stages: ["init", "revisit"],
  codingAgent: "claude-code",
  model: "m",
  skills: { entrypoints: ["code-it"], support: [] },
  needs: [],
  extensions: {},
};

function selfRecord(
  messageId: string,
  stage: string,
  sourceTrigger: "self" | "scheduler",
  payload: Record<string, unknown> = {},
): { messageId: string; body: string } {
  return {
    messageId,
    body: JSON.stringify({
      stage,
      payload,
      metadata: {
        sourceTrigger,
        requestId: "publish-time-prov-id",
        publishedAt: "2026-06-10T11:00:00.000Z",
      },
    }),
  };
}

describe("createSqsLambdaShim — self/scheduler runtime messages", () => {
  it("accepts a scheduler tick on a scheduler-trigger agent and re-stamps metadata", async () => {
    const seen: Array<RuntimeMessage<never>> = [];
    const agent = defineAgent({
      identifier: "secure-it",
      async handle(message) {
        seen.push(message as never);
      },
    });
    const shim = createSqsLambdaShim({
      agent,
      descriptor: SCHEDULER_DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: new MemoryIdempotencyStore(),
      logger: QUIET_LOGGER,
      clock: () => "2026-06-10T12:00:00.000Z",
    });
    const event: SqsEvent = { Records: [selfRecord("tick-1", "init", "scheduler")] };
    const result = await shim(event);
    expect(result.results[0]?.status).toBe("handled");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stage).toBe("init");
    expect(seen[0]?.metadata.sourceTrigger).toBe("scheduler");
    // Delivery metadata is re-stamped: idempotency key = SQS MessageId.
    expect(seen[0]?.metadata.requestId).toBe("tick-1");
    expect(seen[0]?.metadata.receivedAt).toBe("2026-06-10T12:00:00.000Z");
  });

  it("accepts a self fan-out message and routes the payload through", async () => {
    const seen: Array<RuntimeMessage<TestPayload>> = [];
    const agent = defineAgent({
      identifier: "secure-it",
      async handle(message) {
        seen.push(message as never);
      },
    });
    const shim = createSqsLambdaShim({
      agent,
      descriptor: SCHEDULER_DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: new MemoryIdempotencyStore(),
      logger: QUIET_LOGGER,
    });
    const event: SqsEvent = {
      Records: [selfRecord("fan-1", "breakdown", "self", { projectId: "p1" })],
    };
    const result = await shim(event);
    expect(result.results[0]?.status).toBe("handled");
    expect(seen[0]?.payload.projectId).toBe("p1");
    expect(seen[0]?.metadata.sourceTrigger).toBe("self");
  });

  it("rejects an undeclared stage with runtime-message-rejected (kept for DLQ)", async () => {
    const handle = vi.fn(async () => {});
    const shim = createSqsLambdaShim({
      agent: defineAgent({ identifier: "secure-it", handle }),
      descriptor: { ...SCHEDULER_DESCRIPTOR, stages: ["init"] },
      runtime: {} as Runtime,
      idempotencyStore: new MemoryIdempotencyStore(),
      logger: QUIET_LOGGER,
    });
    const event: SqsEvent = { Records: [selfRecord("bad-1", "revisit", "self")] };
    const result = await shim(event);
    expect(result.results[0]?.status).toBe("runtime-message-rejected");
    expect(result.batchItemFailures).toHaveLength(1);
    expect(handle).not.toHaveBeenCalled();
  });

  it("rejects scheduler-sourced bodies when no scheduler trigger is declared", async () => {
    const handle = vi.fn(async () => {});
    const shim = createSqsLambdaShim({
      agent: defineAgent({ identifier: "ship-it", handle }),
      descriptor: MIXED_DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: new MemoryIdempotencyStore(),
      consumerRegistry: new MemoryConsumerRegistry([]),
      logger: QUIET_LOGGER,
      allowUnsignedRuntimeMessagesWithConsumerTrigger: true,
    });
    const event: SqsEvent = { Records: [selfRecord("tick-2", "init", "scheduler")] };
    const result = await shim(event);
    expect(result.results[0]?.status).toBe("runtime-message-rejected");
    expect(handle).not.toHaveBeenCalled();
  });

  it("forgery guard: rejects unsigned runtime messages on a signedEnvelope consumer agent by default", async () => {
    const handle = vi.fn(async () => {});
    const shim = createSqsLambdaShim({
      agent: defineAgent({ identifier: "ship-it", handle }),
      descriptor: MIXED_DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: new MemoryIdempotencyStore(),
      consumerRegistry: new MemoryConsumerRegistry([]),
      logger: QUIET_LOGGER,
    });
    const event: SqsEvent = { Records: [selfRecord("forge-1", "revisit", "self")] };
    const result = await shim(event);
    expect(result.results[0]?.status).toBe("runtime-message-rejected");
    expect(result.results[0]?.error).toContain("allowUnsignedRuntimeMessagesWithConsumerTrigger");
    expect(handle).not.toHaveBeenCalled();
  });

  it("accepts self messages on a mixed agent when the trust flag is set", async () => {
    const handle = vi.fn(async () => {});
    const shim = createSqsLambdaShim({
      agent: defineAgent({ identifier: "ship-it", handle }),
      descriptor: MIXED_DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: new MemoryIdempotencyStore(),
      consumerRegistry: new MemoryConsumerRegistry([]),
      logger: QUIET_LOGGER,
      allowUnsignedRuntimeMessagesWithConsumerTrigger: true,
    });
    const event: SqsEvent = {
      Records: [selfRecord("self-ok-1", "revisit", "self", { prNumber: 7 })],
    };
    const result = await shim(event);
    expect(result.results[0]?.status).toBe("handled");
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("rejects envelope-shaped bodies on a scheduler-only agent", async () => {
    const handle = vi.fn(async () => {});
    const shim = createSqsLambdaShim({
      agent: defineAgent({ identifier: "secure-it", handle }),
      descriptor: SCHEDULER_DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: new MemoryIdempotencyStore(),
      logger: QUIET_LOGGER,
    });
    const event: SqsEvent = {
      Records: [
        {
          messageId: "env-1",
          body: JSON.stringify({ kind: "ask", requestId: "r", consumer: "c", payload: {} }),
        },
      ],
    };
    const result = await shim(event);
    expect(result.results[0]?.status).toBe("envelope-rejected");
    expect(handle).not.toHaveBeenCalled();
  });

  it("idempotency claim still applies to self messages (duplicate-completed ACKs)", async () => {
    const handle = vi.fn(async () => {});
    const idempotency = new MemoryIdempotencyStore();
    const shim = createSqsLambdaShim({
      agent: defineAgent({ identifier: "secure-it", handle }),
      descriptor: SCHEDULER_DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: idempotency,
      logger: QUIET_LOGGER,
    });
    const event: SqsEvent = { Records: [selfRecord("dup-1", "breakdown", "self")] };
    await shim(event);
    const second = await shim(event);
    expect(second.results[0]?.status).toBe("duplicate-completed");
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("throws at construction when neither consumer nor scheduler trigger is declared", () => {
    expect(() =>
      createSqsLambdaShim({
        agent: defineAgent({ identifier: "x", handle: async () => {} }),
        descriptor: { ...SCHEDULER_DESCRIPTOR, triggers: [] },
        runtime: {} as Runtime,
        idempotencyStore: new MemoryIdempotencyStore(),
        logger: QUIET_LOGGER,
      }),
    ).toThrow(/neither a 'consumer' nor a 'scheduler' trigger/);
  });
});
