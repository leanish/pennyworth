import { describe, expect, it, vi } from "vitest";

import type {
  EventBridgeClient,
  Project,
  PutEventsRequest,
  PutEventsResult,
  Runtime,
  RuntimeMessage,
  SendMessageRequest,
  SendMessageResult,
  SqsClient,
} from "@leanish/agent-runtime";

import { handleAtcMessage } from "../src/handler.js";
import type { AtcPayload } from "../src/payload.js";
import { SCOPE_ONLY_ANSWER } from "../src/terminal-reply.js";

const PROJECT: Project = {
  id: "leanish/agent-atc",
  source: { url: "https://github.com/leanish/agent-atc.git", branch: "main" },
  extensions: { atc: { enabled: true } },
};

function buildRuntime(args: {
  readonly skillResponse?: unknown;
  readonly skillThrows?: Error;
}): {
  runtime: Runtime;
  putEvents: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  runSkillCalls: Array<unknown>;
} {
  const putEvents = vi.fn(async (_: PutEventsRequest): Promise<PutEventsResult> => ({
    failedCount: 0,
  }));
  const sendMessage = vi.fn(
    async (_: SendMessageRequest): Promise<SendMessageResult> => ({ messageId: "reply-1" }),
  );
  const eventbridge: EventBridgeClient = { putEvents };
  const sqs: SqsClient = { sendMessage };

  const runSkillCalls: Array<unknown> = [];
  const runtime: Runtime = {
    catalog: {
      forConsumer: () => ({
        list: () => [PROJECT],
        get: (id: string) => (id === PROJECT.id ? PROJECT : undefined),
      }),
    },
    routeProjects: async () => [PROJECT],
    syncWorkingCopies: async (projects) => ({
      workingCopies: projects.map((p) => ({
        projectId: p.id,
        path: `/synthetic/${p.id}`,
        branch: p.source.branch,
        headSha: "0".repeat(40),
      })),
      report: projects.map((p) => ({
        projectId: p.id,
        outcome: "cloned" as const,
        toSha: "0".repeat(40),
      })),
    }),
    execution: {
      resolve: () => ({ codingAgent: "claude-code", model: "claude-sonnet-4-6" }),
    },
    async runSkill(skillArgs) {
      runSkillCalls.push(skillArgs);
      if (args.skillThrows !== undefined) throw args.skillThrows;
      return (args.skillResponse ?? { answer: "fine" }) as never;
    },
    clients: { eventbridge, sqs } as never,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      with() {
        return this;
      },
    },
  };
  return { runtime, putEvents, sendMessage, runSkillCalls };
}

function makeMessage(request: Record<string, unknown>): RuntimeMessage<AtcPayload> {
  return {
    stage: "init",
    payload: {
      envelope: {
        kind: "ask",
        requestId: "biz-1",
        consumer: "atc-ui",
        endUser: "github:U1",
        timestamp: "2026-05-23T00:00:00.000Z",
        replyTo: "arn:aws:sqs:us-east-1:000000000000:replies",
      },
      request: request as never,
    },
    metadata: {
      receivedAt: "2026-05-23T00:00:00.000Z",
      sourceTrigger: "consumer",
      requestId: "sqs-1",
    },
  };
}

describe("ATC handleAtcMessage", () => {
  it("happy path — emits started → status × 3 → completed and delivers reply", async () => {
    const { runtime, putEvents, sendMessage, runSkillCalls } = buildRuntime({
      skillResponse: { answer: "auth signs in users" },
    });
    await handleAtcMessage(
      makeMessage({ question: "What does auth do?", projectIds: [PROJECT.id] }),
      runtime,
    );
    const detailTypes = putEvents.mock.calls.map(
      (call) => (call[0] as PutEventsRequest).entries[0]!.detailType,
    );
    expect(detailTypes).toEqual([
      "atc.ask.started",
      "atc.ask.status",
      "atc.ask.status",
      "atc.ask.status",
      "atc.ask.completed",
    ]);
    expect(sendMessage).toHaveBeenCalledOnce();
    const reply = JSON.parse(sendMessage.mock.calls[0]![0].body);
    expect(reply).toMatchObject({
      requestId: "biz-1",
      status: "completed",
      result: {
        answer: "auth signs in users",
        projectScope: { source: "payload-project-ids" },
      },
    });

    // The runSkill input matches the `ask` skill's inputSchema.
    expect(runSkillCalls).toHaveLength(1);
    const skillArgs = runSkillCalls[0] as {
      entrypoint: string;
      input: { question: string; audience: string; projectScope: { source: string } };
    };
    expect(skillArgs.entrypoint).toBe("ask");
    expect(skillArgs.input.question).toBe("What does auth do?");
    expect(skillArgs.input.audience).toBe("general");
    expect(skillArgs.input.projectScope.source).toBe("payload-project-ids");
  });

  it("scope-only — skips sync + skill, delivers complete-shape diagnostic reply", async () => {
    const { runtime, putEvents, sendMessage, runSkillCalls } = buildRuntime({});
    await handleAtcMessage(
      makeMessage({ question: "X?", projectIds: [PROJECT.id], scopeOnly: true }),
      runtime,
    );
    expect(runSkillCalls).toHaveLength(0);
    const detailTypes = putEvents.mock.calls.map(
      (call) => (call[0] as PutEventsRequest).entries[0]!.detailType,
    );
    // Sequence: started → project-resolution entered (status) →
    // working-copy-sync skipped (status) → coding-agent-execution skipped
    // (status) → completed. project-resolution fires BEFORE scope-only
    // branch decides anything; sync + execution skips fire from inside
    // the scope-only branch.
    expect(detailTypes).toEqual([
      "atc.ask.started",
      "atc.ask.status",
      "atc.ask.status",
      "atc.ask.status",
      "atc.ask.completed",
    ]);
    const reply = JSON.parse(sendMessage.mock.calls[0]![0].body);
    expect(reply.status).toBe("completed");
    // #9: every AtcTerminalResult field is required, even for scope-only.
    // `answer` is the canonical sentinel; `agent` + `syncReport` + `durationMs`
    // are present.
    expect(reply.result.answer).toBe(SCOPE_ONLY_ANSWER);
    expect(reply.result.projectScope.source).toBe("payload-project-ids");
    expect(reply.result.syncReport).toEqual([]);
    expect(reply.result.agent).toEqual({ kind: "claude-code", model: "claude-sonnet-4-6" });
    expect(typeof reply.result.durationMs).toBe("number");
  });

  it("scope-only with bad execution override fails BEFORE any skipped-stage events fire", async () => {
    const { ExecutionResolveError } = await import("@leanish/agent-runtime");
    const { runtime, putEvents, sendMessage, runSkillCalls } = buildRuntime({});
    // Override resolve() to throw — simulates an invalid `payload.execution`.
    // Cast via `unknown` because `Runtime` is broader than the mock shape.
    (runtime as unknown as { execution: { resolve: () => never } }).execution.resolve = () => {
      throw new ExecutionResolveError("invalid-effort", "bad override");
    };
    await handleAtcMessage(
      makeMessage({ question: "X?", projectIds: [PROJECT.id], scopeOnly: true }),
      runtime,
    );
    expect(runSkillCalls).toHaveLength(0);
    const detailTypes = putEvents.mock.calls.map(
      (call) => (call[0] as PutEventsRequest).entries[0]!.detailType,
    );
    // started → failed; NO `status` events emitted because the throw
    // happens BEFORE any stage transition. This is what #6 guards against.
    expect(detailTypes).toEqual(["atc.ask.started", "atc.ask.failed"]);
    const reply = JSON.parse(sendMessage.mock.calls[0]![0].body);
    expect(reply).toMatchObject({
      status: "failed",
      error: { kind: "validation-error" },
    });
  });

  it("unknown projectIds throw and surface as validation-error (no silent skip)", async () => {
    const { runtime, putEvents, sendMessage, runSkillCalls } = buildRuntime({});
    await handleAtcMessage(
      makeMessage({
        question: "X?",
        projectIds: ["leanish/does-not-exist", "leanish/also-missing"],
      }),
      runtime,
    );
    expect(runSkillCalls).toHaveLength(0);
    const detailTypes = putEvents.mock.calls.map(
      (call) => (call[0] as PutEventsRequest).entries[0]!.detailType,
    );
    expect(detailTypes).toEqual([
      "atc.ask.started",
      "atc.ask.status", // project-resolution entered fires before the throw
      "atc.ask.failed",
    ]);
    const reply = JSON.parse(sendMessage.mock.calls[0]![0].body);
    expect(reply).toMatchObject({ status: "failed", error: { kind: "validation-error" } });
    expect(reply.error.message).toContain("leanish/does-not-exist");
    expect(reply.error.message).toContain("leanish/also-missing");
  });

  it("missing router throws config-error (no silent fallback to all-projects)", async () => {
    const { RouterNotConfiguredError } = await import("@leanish/agent-runtime");
    const { runtime, sendMessage, runSkillCalls } = buildRuntime({});
    // Override routeProjects to throw RouterNotConfiguredError — the
    // shape the runtime emits when no router was wired into buildRuntime.
    runtime.routeProjects = async () => {
      throw new RouterNotConfiguredError();
    };
    await handleAtcMessage(
      makeMessage({ question: "X?" }), // no projectIds, no includeAll → router path
      runtime,
    );
    expect(runSkillCalls).toHaveLength(0);
    const reply = JSON.parse(sendMessage.mock.calls[0]![0].body);
    expect(reply).toMatchObject({ status: "failed", error: { kind: "config-error" } });
  });

  it("router returning empty array falls back to all-projects (router-empty-fallback)", async () => {
    const { runtime, runSkillCalls } = buildRuntime({ skillResponse: { answer: "x" } });
    runtime.routeProjects = async () => [];
    await handleAtcMessage(makeMessage({ question: "X?" }), runtime);
    const skillArgs = runSkillCalls[0] as {
      input: { projectScope: { source: string } };
    };
    expect(skillArgs.input.projectScope.source).toBe("router-empty-fallback");
  });

  it("validation-error — invalid request maps to terminal failure", async () => {
    const { runtime, sendMessage, runSkillCalls } = buildRuntime({});
    await handleAtcMessage(
      makeMessage({}), // missing required `question`
      runtime,
    );
    expect(runSkillCalls).toHaveLength(0);
    const reply = JSON.parse(sendMessage.mock.calls[0]![0].body);
    expect(reply).toMatchObject({
      status: "failed",
      error: { kind: "validation-error" },
    });
  });

  it("agent-error — skill output failure maps to terminal failure with the correct kind", async () => {
    const { EntrypointInvocationError } = await import("@leanish/agent-runtime");
    const { runtime, sendMessage } = buildRuntime({
      skillThrows: new EntrypointInvocationError(
        "output-validation-fail",
        "ask",
        "schema mismatch",
      ),
    });
    await handleAtcMessage(
      makeMessage({ question: "X?", projectIds: [PROJECT.id] }),
      runtime,
    );
    const reply = JSON.parse(sendMessage.mock.calls[sendMessage.mock.calls.length - 1]![0].body);
    expect(reply).toMatchObject({
      status: "failed",
      error: { kind: "agent-error" },
    });
  });

  it("LifecycleProgrammingError from a duplicate stage emission maps to config-error (not io-error)", async () => {
    // Make the skill handler "succeed" but re-emit a stage during the run
    // by hijacking the runSkill call. We can't easily reach the emitter
    // from outside, so we drive a duplicate via the runSkill seam: the
    // testagent's fake handler emits an extra stage event by reflecting
    // through `runtime.clients.eventbridge` directly... but the actual
    // production path is: ATC calls lifecycle.stage(...) twice. We
    // simulate that condition by throwing a fresh LifecycleProgrammingError
    // from inside the runSkill stub — the handler's outer catch must map
    // it to config-error, not the default io-error.
    const { LifecycleProgrammingError } = await import("../src/lifecycle-events.js");
    const thrown = new LifecycleProgrammingError(
      "duplicate emission of stage 'coding-agent-execution'",
      "coding-agent-execution",
    );
    const { runtime, sendMessage } = buildRuntime({ skillThrows: thrown });
    await handleAtcMessage(
      makeMessage({ question: "X?", projectIds: [PROJECT.id] }),
      runtime,
    );
    const reply = JSON.parse(sendMessage.mock.calls[0]![0].body);
    expect(reply).toMatchObject({
      status: "failed",
      error: { kind: "config-error" },
    });
    expect(reply.error.message).toContain("duplicate emission");
  });

  it("noSync — emits working-copy-sync skipped, runs the skill with empty workingCopies, and reports per-project 'skipped' entries", async () => {
    const { runtime, putEvents, sendMessage, runSkillCalls } = buildRuntime({
      skillResponse: { answer: "x" },
    });
    await handleAtcMessage(
      makeMessage({ question: "X?", projectIds: [PROJECT.id], noSync: true }),
      runtime,
    );
    const statusDetails = putEvents.mock.calls
      .map((c) => (c[0] as PutEventsRequest).entries[0]!.detail as Record<string, unknown>)
      .filter((d) => d["stage"] === "working-copy-sync");
    expect(statusDetails).toHaveLength(1);
    expect(statusDetails[0]).toMatchObject({ state: "skipped", reason: "no-sync" });
    const skillArgs = runSkillCalls[0] as { workingCopies: unknown[] };
    expect(skillArgs.workingCopies).toEqual([]);
    // syncReport carries one 'skipped' entry per resolved project so
    // consumers can distinguish "I asked you to not sync" from "there was
    // nothing to sync". (Without this, both paths produced [].)
    const reply = JSON.parse(sendMessage.mock.calls[0]![0].body);
    expect(reply.result.syncReport).toEqual([{ id: PROJECT.id, outcome: "skipped" }]);
  });

  it("post-completion delivery failure propagates for SQS retry — emits completed, never failed", async () => {
    const { runtime, putEvents, sendMessage } = buildRuntime({ skillResponse: { answer: "x" } });
    // The work succeeds; the terminal-reply SQS send fails. This must NOT be
    // converted into a `failed` reply (the run succeeded + `completed` fired) —
    // it propagates so the shim reports a batchItemFailure and SQS retries
    // (at-least-once; F-ATC-1).
    sendMessage.mockRejectedValue(new Error("sqs sendMessage failed"));

    await expect(
      handleAtcMessage(makeMessage({ question: "X?", projectIds: [PROJECT.id] }), runtime),
    ).rejects.toThrow(/sqs sendMessage failed/);

    const detailTypes = putEvents.mock.calls.map(
      (c) => (c[0] as PutEventsRequest).entries[0]!.detailType,
    );
    expect(detailTypes).toContain("atc.ask.completed"); // work succeeded → completed fired
    expect(detailTypes).not.toContain("atc.ask.failed"); // delivery failure is NOT a work failure
  });
});
