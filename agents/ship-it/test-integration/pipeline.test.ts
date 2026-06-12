import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GetItemCommand } from "@aws-sdk/client-dynamodb";
// Scheduler SDK resolves from the workspace root (a dependency of
// @leanish/runtime); integration-test-only, never imported by src/.
import {
  GetScheduleCommand,
  ListSchedulesCommand,
} from "@aws-sdk/client-scheduler";

import { FakeCodingAgentRunner, LocalStackHarness } from "@leanish/runtime/testing";

import { createShipItLambdaHandler } from "../src/lambda.js";
import {
  createLocalGitRepo,
  fenced,
  makeSignedEnvelope,
  provisionShipItStack,
  readOneMessage,
  sendToQueue,
  SHIP_IT_ENV_NAMES,
  shipItRequest,
  type CatalogProjectRecord,
} from "./helpers.js";

// code-it is merged dark in production (the live rollout starts from
// groom-it); this suite exercises the code-it stage pipeline itself, so
// flip it released here — the same override the unit tests use. The
// production default is pinned in test/steps.test.ts and exercised on the
// full pipeline in test-integration/dark-steps.test.ts.
vi.mock("../src/steps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/steps.js")>();
  return {
    ...actual,
    SHIP_IT_STEPS: {
      ...actual.SHIP_IT_STEPS,
      "code-it": { ...actual.SHIP_IT_STEPS["code-it"]!, released: true },
    },
  };
});

/**
 * ship-it's full stage pipeline against real LocalStack:
 *
 *   signed `ship-it-event` envelope → real SQS input queue → Lambda handler
 *   (real DDB ConsumerRegistry + SSM SecureString signing key + real DDB
 *   idempotency + real S3 catalog + real git working-copy clone) → code-it
 *   (FakeCodingAgentRunner) → `publishDelayed` → real EventBridge Scheduler
 *   schedule → simulated fire (LocalStack Community stores but never
 *   executes schedules; the fire is reproduced by delivering the schedule's
 *   own Target.Input to the queue) → unsigned self `revisit` runtime
 *   message through the same handler → code-it-revisit → reschedule with a
 *   bumped revisitCount.
 *
 * `stack.start()` throws `LocalStackUnavailableError` if LocalStack isn't
 * reachable — the integration gate fails loudly rather than silently
 * skipping.
 */
describe("ship-it stage pipeline against LocalStack", () => {
  const stack = new LocalStackHarness();
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await stack.start();
    for (const name of SHIP_IT_ENV_NAMES) {
      originalEnv[name] = process.env[name];
    }
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await stack.stop();
  });

  beforeEach(() => {
    for (const name of SHIP_IT_ENV_NAMES) {
      delete process.env[name];
    }
  });

  const PR_OPENED_OUTPUT = {
    outcome: "pr-opened",
    pullRequest: {
      url: "https://github.com/acme/widgets/pull/42",
      number: 42,
      branch: "ship-it/ABC-123",
    },
    notes: "implemented and tested",
  };

  function enabledProject(repoPath: string): CatalogProjectRecord {
    return {
      id: "acme/widgets",
      source: { url: repoPath, branch: "main" },
      extensions: { "ship-it": { enabled: true } },
    };
  }

  it("init envelope → code-it (real clone) → real schedule → simulated fire → revisit → reschedule; redelivery dedupes", async () => {
    const repoPath = createLocalGitRepo();
    const ctx = await provisionShipItStack(stack, [enabledProject(repoPath)]);

    const runner = new FakeCodingAgentRunner("claude-code");
    runner.register("code-it", () => fenced(PR_OPENED_OUTPUT));
    runner.register("code-it-revisit", () =>
      fenced({
        outcome: "deferred",
        ciConclusion: "pending",
        scheduleRevisit: { afterSeconds: 1800 },
      }),
    );
    const handler = await createShipItLambdaHandler({
      runners: new Map([["claude-code", runner]]),
    });

    // --- init: the signed consumer envelope rides the REAL input queue ---
    const envelope = makeSignedEnvelope({
      payload: shipItRequest("acme/widgets"),
      secret: ctx.consumerSecret,
      requestId: "gh-delivery-e2e-1",
    });
    await sendToQueue(stack, ctx.queueUrl, JSON.stringify(envelope));
    const initRecord = await readOneMessage(stack, ctx.queueUrl);

    const initResult = await handler({
      Records: [{ messageId: initRecord.messageId, body: initRecord.body }],
    });
    expect(initResult.batchItemFailures).toHaveLength(0);
    expect(initResult.results[0]?.status).toBe("handled");

    // code-it ran once, against a REAL git clone of the fixture project.
    expect(runner.invocations).toHaveLength(1);
    const codeIt = runner.invocations[0]!;
    expect(codeIt.entrypoint.name).toBe("code-it");
    expect(codeIt.workingCopies.map((wc) => wc.projectId)).toEqual(["acme/widgets"]);
    const workingCopyPath = codeIt.workingCopies[0]!.path;
    expect(existsSync(join(workingCopyPath, "README.md"))).toBe(true);
    expect(codeIt.renderedArguments).toContain("ticketKey: ABC-123");

    // The idempotency record landed as `completed` (real conditional write).
    const idem = await stack.dynamoClient().send(
      new GetItemCommand({
        TableName: ctx.idempotencyTable,
        Key: { pk: { S: initRecord.messageId } },
        ConsistentRead: true,
      }),
    );
    expect(idem.Item?.["status"]?.S).toBe("completed");

    // --- publishDelayed created ONE real one-shot schedule ---
    const scheduler = stack.schedulerClient();
    const listed = await scheduler.send(
      new ListSchedulesCommand({ GroupName: ctx.scheduleGroupName }),
    );
    expect(listed.Schedules).toHaveLength(1);
    const schedule = await scheduler.send(
      new GetScheduleCommand({
        Name: listed.Schedules![0]!.Name!,
        GroupName: ctx.scheduleGroupName,
      }),
    );
    expect(schedule.ScheduleExpression).toMatch(/^at\(/);
    expect(schedule.Target?.Arn).toBe(ctx.queueArn);
    const targetInput = JSON.parse(schedule.Target?.Input ?? "{}") as {
      stage: string;
      payload: Record<string, unknown>;
    };
    expect(targetInput.stage).toBe("revisit");
    expect(targetInput.payload).toEqual({
      ticketKey: "ABC-123",
      projectId: "acme/widgets",
      prNumber: 42,
      branch: "ship-it/ABC-123",
      revisitCount: 0,
    });

    // --- simulate the fire: deliver Target.Input to the queue, byte-for-byte
    // what Scheduler's SQS SendMessage target does in AWS ---
    await sendToQueue(stack, ctx.queueUrl, schedule.Target!.Input!);
    const revisitRecord = await readOneMessage(stack, ctx.queueUrl);
    const revisitResult = await handler({
      Records: [{ messageId: revisitRecord.messageId, body: revisitRecord.body }],
    });
    expect(revisitResult.batchItemFailures).toHaveLength(0);
    expect(revisitResult.results[0]?.status).toBe("handled");

    // code-it-revisit ran with the revisit input (no working copies).
    expect(runner.invocations).toHaveLength(2);
    const revisit = runner.invocations[1]!;
    expect(revisit.entrypoint.name).toBe("code-it-revisit");
    expect(revisit.workingCopies).toEqual([]);
    expect(revisit.renderedArguments).toContain("prNumber: 42");
    expect(revisit.renderedArguments).toContain("revisitCount: 0");

    // The deferred outcome rescheduled with a bumped revisitCount — a
    // SECOND real schedule (the name derives from the payload, so the
    // bumped count produces a new name).
    const relisted = await scheduler.send(
      new ListSchedulesCommand({ GroupName: ctx.scheduleGroupName }),
    );
    expect(relisted.Schedules).toHaveLength(2);
    const newName = relisted.Schedules!.map((s) => s.Name!).find(
      (name) => name !== listed.Schedules![0]!.Name,
    );
    const rescheduled = await scheduler.send(
      new GetScheduleCommand({ Name: newName!, GroupName: ctx.scheduleGroupName }),
    );
    const rescheduledInput = JSON.parse(rescheduled.Target?.Input ?? "{}") as {
      payload: Record<string, unknown>;
    };
    expect(rescheduledInput.payload["revisitCount"]).toBe(1);

    // --- SQS at-least-once: redelivery of the init MessageId is deduped by
    // the real DDB three-state claim; the skill does NOT re-run ---
    const redelivery = await handler({
      Records: [{ messageId: initRecord.messageId, body: initRecord.body }],
    });
    expect(redelivery.results[0]?.status).toBe("duplicate-completed");
    expect(redelivery.batchItemFailures).toHaveLength(0);
    expect(runner.invocations).toHaveLength(2);
  });

  it("rejects a tampered envelope signature (batch item failure → DLQ path); skill never runs", async () => {
    const repoPath = createLocalGitRepo();
    const ctx = await provisionShipItStack(stack, [enabledProject(repoPath)]);
    const runner = new FakeCodingAgentRunner("claude-code");
    const handler = await createShipItLambdaHandler({
      runners: new Map([["claude-code", runner]]),
    });

    const envelope = makeSignedEnvelope({
      payload: shipItRequest("acme/widgets"),
      secret: ctx.consumerSecret,
      tamper: true,
    });
    const result = await handler({
      Records: [{ messageId: "tampered-1", body: JSON.stringify(envelope) }],
    });

    expect(result.results[0]?.status).toBe("envelope-rejected");
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "tampered-1" }]);
    expect(runner.invocations).toHaveLength(0);
  });

  it("rejects an envelope signed with a key the registry does not hold", async () => {
    const repoPath = createLocalGitRepo();
    await provisionShipItStack(stack, [enabledProject(repoPath)]);
    const runner = new FakeCodingAgentRunner("claude-code");
    const handler = await createShipItLambdaHandler({
      runners: new Map([["claude-code", runner]]),
    });

    const envelope = makeSignedEnvelope({
      payload: shipItRequest("acme/widgets"),
      secret: "not-the-registered-secret",
    });
    const result = await handler({
      Records: [{ messageId: "wrong-key-1", body: JSON.stringify(envelope) }],
    });

    expect(result.results[0]?.status).toBe("envelope-rejected");
    expect(result.batchItemFailures).toHaveLength(1);
    expect(runner.invocations).toHaveLength(0);
  });
});
