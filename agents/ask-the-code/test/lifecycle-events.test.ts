import { describe, expect, it, vi } from "vitest";

import type {
  EventBridgeClient,
  Logger,
  PutEventsRequest,
  PutEventsResult,
  Runtime,
} from "@leanish/runtime";

import { LifecycleEmitter, LifecycleProgrammingError } from "../src/lifecycle-events.js";
import type { AtcEnvelope } from "../src/payload.js";

const ENVELOPE: AtcEnvelope = {
  kind: "ask",
  requestId: "req-1",
  consumer: "atc-ui",
  endUser: "local:dev",
  timestamp: "2026-05-23T00:00:00.000Z",
};

function buildLoggingRuntime(args?: {
  readonly putEventsThrows?: Error;
  readonly noEventbridge?: boolean;
}): {
  readonly runtime: Runtime;
  readonly warns: Array<{ msg: string; fields?: Record<string, unknown> }>;
  readonly errors: Array<{ msg: string; fields?: Record<string, unknown> }>;
  readonly putEvents: ReturnType<typeof vi.fn>;
} {
  const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const errors: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(msg, fields) {
      warns.push({ msg, ...(fields !== undefined ? { fields } : {}) });
    },
    error(msg, fields) {
      errors.push({ msg, ...(fields !== undefined ? { fields } : {}) });
    },
    with() {
      return this;
    },
  };
  const putEvents = vi.fn(async (_: PutEventsRequest): Promise<PutEventsResult> => {
    if (args?.putEventsThrows !== undefined) throw args.putEventsThrows;
    return { failedCount: 0 };
  });
  const eventbridge: EventBridgeClient = { putEvents };
  const runtime: Runtime = {
    catalog: {
      forConsumer: () => ({ list: () => [], get: () => undefined }),
    },
    routeProjects: async () => [],
    publish: async () => {
      throw new Error("publish not configured in this test runtime");
    },
    publishDelayed: async () => {
      throw new Error("publishDelayed not configured in this test runtime");
    },
    syncWorkingCopies: async () => ({ workingCopies: [], report: [] }),
    execution: { resolve: () => ({ codingAgent: "claude-code", model: "m" }) },
    runSkill: async () => ({}) as never,
    clients: (args?.noEventbridge ? {} : { eventbridge }) as never,
    logger,
  };
  return { runtime, warns, errors, putEvents };
}

describe("LifecycleEmitter", () => {
  it("emits each stage exactly once and forwards detail to EventBridge", async () => {
    const { runtime, putEvents } = buildLoggingRuntime();
    const emitter = new LifecycleEmitter(runtime, ENVELOPE);
    await emitter.started();
    await emitter.stage("project-resolution", "entered");
    await emitter.stage("working-copy-sync", "skipped", "no-projects");
    expect(putEvents).toHaveBeenCalledTimes(3);
  });

  it("duplicate stage emission throws LifecycleProgrammingError and does not double-emit", async () => {
    const { runtime, putEvents } = buildLoggingRuntime();
    const emitter = new LifecycleEmitter(runtime, ENVELOPE);
    await emitter.stage("project-resolution", "entered");
    try {
      await emitter.stage("project-resolution", "entered"); // duplicate
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LifecycleProgrammingError);
      expect((err as LifecycleProgrammingError).stage).toBe("project-resolution");
    }
    // First emission still made it to EventBridge; the second was rejected
    // before any second putEvents call.
    expect(putEvents).toHaveBeenCalledTimes(1);
  });

  it("EventBridge throw is logged at ERROR level, not warn (loud enough for CloudWatch alarms)", async () => {
    const { runtime, warns, errors } = buildLoggingRuntime({
      putEventsThrows: new Error("simulated IAM denial"),
    });
    const emitter = new LifecycleEmitter(runtime, ENVELOPE);
    await emitter.started();
    expect(errors.find((e) => e.msg.includes("lifecycle event emission failed"))).toBeDefined();
    // The emission failure must not appear at warn level (that was the
    // previous, too-quiet behavior).
    expect(warns.find((w) => w.msg.includes("lifecycle event emission failed"))).toBeUndefined();
  });

  it("missing eventbridge client logs at ERROR level (deploy misconfiguration)", async () => {
    const { runtime, errors } = buildLoggingRuntime({ noEventbridge: true });
    const emitter = new LifecycleEmitter(runtime, ENVELOPE);
    await emitter.started();
    expect(
      errors.find((e) => e.msg.includes("eventbridge client unavailable")),
    ).toBeDefined();
  });
});
