import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GetScheduleCommand, ListSchedulesCommand } from "@aws-sdk/client-scheduler";
import { SendMessageCommand } from "@aws-sdk/client-sqs";

import { createSqsLambdaShim } from "../src/aws-mode/sqs-lambda-shim.js";
import { defineAgent } from "../src/define-agent.js";
import { DynamoIdempotencyStore } from "../src/idempotency/dynamo.js";
import { ConsoleLogger } from "../src/logger/console-logger.js";
import { createAwsSelfPublisher } from "../src/self-publish/aws-self-publisher.js";
import { deriveScheduleName, type SelfMessageBody } from "../src/self-publish/serialize.js";
import { LocalStackHarness } from "../src/testing/localstack-harness.js";
import type { AgentDescriptor } from "../src/types/descriptor.js";
import type { Runtime } from "../src/types/runtime.js";
import type { RuntimeMessage } from "../src/types/runtime-message.js";

/**
 * End-to-end tests for the ADR-0011 self-publish path against real
 * LocalStack SQS / DynamoDB / EventBridge Scheduler:
 *
 *   `createAwsSelfPublisher.publish` → agent input queue → SQS Lambda shim
 *   (real `DynamoIdempotencyStore`) → dispatch, plus the duplicate-delivery
 *   ACK; and `publishDelayed` → `CreateSchedule` round-trip + name-derived
 *   dedupe + the scheduled body's shim admissibility.
 *
 * One deliberate simulation: LocalStack Community backs the `scheduler`
 * service with a CRUD-only store (moto's `EventBridgeSchedulerBackend` —
 * verified empirically against LocalStack 4.14.0: an `at()` schedule due in
 * 5s never fired within 90s and was never deleted). Schedules round-trip
 * faithfully but are not *executed*, so the "Scheduler fires the target"
 * hop is reproduced by sending the schedule's own `Target.Input` to the
 * queue — byte-for-byte what EventBridge Scheduler's SQS SendMessage
 * target does in AWS.
 *
 * `stack.start()` below throws `LocalStackUnavailableError` if LocalStack
 * isn't reachable — the integration gate fails loudly rather than
 * silently skipping.
 */
describe("AWS self-publish against LocalStack", () => {
  const stack = new LocalStackHarness();

  beforeAll(async () => {
    await stack.start();
  });

  afterAll(async () => {
    await stack.stop();
  });

  const QUIET_LOGGER = new ConsoleLogger({ minLevel: "error" });

  /** Phase-2 style scheduler-driven agent (mirrors secure-it's shape). */
  const DESCRIPTOR: AgentDescriptor = {
    identifier: "self-publish-it",
    compute: "lambda",
    triggers: [{ type: "scheduler", queueArnRef: "q", dlqArnRef: "dlq" }],
    stages: ["init", "breakdown", "revisit"],
    codingAgent: "claude-code",
    model: "m",
    skills: { entrypoints: ["self-publish-it"], support: [] },
    needs: [],
    extensions: {},
  };

  function buildShim(tableName: string, seen: Array<RuntimeMessage<never>>) {
    const agent = defineAgent({
      identifier: DESCRIPTOR.identifier,
      async handle(message) {
        seen.push(message as never);
      },
    });
    return createSqsLambdaShim({
      agent,
      descriptor: DESCRIPTOR,
      runtime: {} as Runtime,
      idempotencyStore: new DynamoIdempotencyStore({
        tableName,
        client: stack.dynamoClient(),
      }),
      logger: QUIET_LOGGER,
    });
  }

  it("publish lands on the input queue and the shim claims + dispatches it; redelivery ACKs as duplicate", async () => {
    const { queueUrl, queueArn } = await stack.createQueue();
    const tableName = await stack.createIdempotencyTable();
    const publisher = createAwsSelfPublisher({
      agentId: DESCRIPTOR.identifier,
      queueUrl,
      queueArn,
      scheduleGroupName: "unused-for-publish",
      schedulerRoleArn: "arn:aws:iam::000000000000:role/unused",
      region: stack.region,
      logger: QUIET_LOGGER,
    });

    await publisher.publish({ stage: "breakdown", payload: { projectId: "p1" } });

    const landed = await stack.readMessages(queueUrl);
    expect(landed).toHaveLength(1);
    const body = JSON.parse(landed[0]!.body) as SelfMessageBody;
    expect(body.stage).toBe("breakdown");
    expect(body.payload).toEqual({ projectId: "p1" });
    expect(body.metadata.sourceTrigger).toBe("self");
    // Publish-time provenance only — the shim re-stamps the delivery key.
    expect(body.metadata.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(body.metadata.publishedAt)).not.toBeNaN();

    const seen: Array<RuntimeMessage<never>> = [];
    const shim = buildShim(tableName, seen);
    const record = { messageId: landed[0]!.messageId, body: landed[0]!.body };

    const first = await shim({ Records: [record] });
    expect(first.results[0]?.status).toBe("handled");
    expect(first.batchItemFailures).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stage).toBe("breakdown");
    expect(seen[0]?.metadata.sourceTrigger).toBe("self");
    // Idempotency key = SQS MessageId, not the publish-time provenance id.
    expect(seen[0]?.metadata.requestId).toBe(landed[0]!.messageId);

    // SQS at-least-once redelivery of the same MessageId: the real DDB
    // conditional write reports the prior completion; no second dispatch.
    const second = await shim({ Records: [record] });
    expect(second.results[0]?.status).toBe("duplicate-completed");
    expect(second.batchItemFailures).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });

  it("publishDelayed creates a one-shot schedule, dedupes by derived name, and its target input is shim-admissible", async () => {
    const { queueUrl, queueArn } = await stack.createQueue();
    const tableName = await stack.createIdempotencyTable();
    const groupName = await stack.createScheduleGroup();
    // Pin the clock so the at() expression is exactly derivable.
    const now = new Date();
    const publisher = createAwsSelfPublisher({
      agentId: DESCRIPTOR.identifier,
      queueUrl,
      queueArn,
      scheduleGroupName: groupName,
      schedulerRoleArn: "arn:aws:iam::000000000000:role/scheduler-send",
      region: stack.region,
      logger: QUIET_LOGGER,
      clock: () => now,
    });
    const payload = { alertRef: "GHSA-1", revisitCount: 0 };

    await publisher.publishDelayed({ stage: "revisit", payload, afterSeconds: 300 });

    const scheduleName = deriveScheduleName({
      agentId: DESCRIPTOR.identifier,
      stage: "revisit",
      payload,
    });
    const scheduler = stack.schedulerClient();
    const schedule = await scheduler.send(
      new GetScheduleCommand({ Name: scheduleName, GroupName: groupName }),
    );
    const expectedFireAt = new Date(now.getTime() + 300_000).toISOString().slice(0, 19);
    expect(schedule.ScheduleExpression).toBe(`at(${expectedFireAt})`);
    expect(schedule.ScheduleExpressionTimezone).toBe("UTC");
    expect(schedule.FlexibleTimeWindow?.Mode).toBe("OFF");
    expect(schedule.ActionAfterCompletion).toBe("DELETE");
    expect(schedule.Target?.Arn).toBe(queueArn);
    expect(schedule.Target?.RoleArn).toBe("arn:aws:iam::000000000000:role/scheduler-send");
    const targetInput = JSON.parse(schedule.Target?.Input ?? "{}") as SelfMessageBody;
    expect(targetInput.stage).toBe("revisit");
    expect(targetInput.payload).toEqual(payload);
    expect(targetInput.metadata.sourceTrigger).toBe("self");

    // Re-publish with the same logical payload (different delay): the
    // derived name collides, CreateSchedule conflicts, and the runtime
    // treats it as deduped success — still exactly one schedule, with the
    // FIRST call's fire time (ADR-0011 §Idempotency).
    await publisher.publishDelayed({ stage: "revisit", payload, afterSeconds: 3600 });
    const listed = await scheduler.send(new ListSchedulesCommand({ GroupName: groupName }));
    expect(listed.Schedules?.map((s) => s.Name)).toEqual([scheduleName]);
    const unchanged = await scheduler.send(
      new GetScheduleCommand({ Name: scheduleName, GroupName: groupName }),
    );
    expect(unchanged.ScheduleExpression).toBe(`at(${expectedFireAt})`);

    // Simulate the fire (see the describe-block doc: LocalStack Community
    // never executes schedules): deliver Target.Input to the queue exactly
    // as Scheduler's SQS SendMessage target would, then run the real shim.
    await stack.sqsClient().send(
      new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: schedule.Target!.Input! }),
    );
    const landed = await stack.readMessages(queueUrl);
    expect(landed).toHaveLength(1);

    const seen: Array<RuntimeMessage<never>> = [];
    const shim = buildShim(tableName, seen);
    const result = await shim({
      Records: [{ messageId: landed[0]!.messageId, body: landed[0]!.body }],
    });
    expect(result.results[0]?.status).toBe("handled");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stage).toBe("revisit");
    expect(seen[0]?.payload).toEqual(payload);
    expect(seen[0]?.metadata.sourceTrigger).toBe("self");
    expect(seen[0]?.metadata.requestId).toBe(landed[0]!.messageId);
  });
});
