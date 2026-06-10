import { createHmac } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { SetQueueAttributesCommand } from "@aws-sdk/client-sqs";

import { canonicalize } from "@leanish/runtime";
import { FakeCodingAgentRunner } from "@leanish/runtime/testing";
import { publishCatalog, type Project } from "@leanish/catalog-it";
import { LocalStackHarness } from "@leanish/runtime/testing";

import { createAtcLambdaHandler } from "../src/lambda.js";
import type { AtcTerminalReply } from "../src/terminal-reply.js";

/**
 * Composite ATC end-to-end test exercised against real LocalStack.
 *
 * Wiring exercised (all on real AWS SDK calls, all routed to LocalStack):
 *   - Envelope verification: real DDB ConsumerRegistry + real SSM Parameter Store
 *   - Idempotency: real DDB conditional-claim three-state
 *   - Skill dispatch: FakeCodingAgentRunner (no live CLI binary needed)
 *   - Lifecycle events: real EventBridge PutEvents → SQS-target rule
 *   - Terminal reply: real SQS SendMessage to envelope.replyTo
 *   - Catalog read: real S3 GetObject
 *
 * The Lambda runner is hard-wired to FakeCodingAgentRunner so the test
 * doesn't depend on a `claude` binary being installed. Everything else
 * runs through the same code paths as production.
 *
 * `stack.start()` below throws `LocalStackUnavailableError` if LocalStack
 * isn't reachable — the integration gate fails loudly rather than
 * silently skipping.
 */
describe("ATC ask end-to-end against LocalStack", () => {
  const stack = new LocalStackHarness();

  // Snapshot the harness's env vars so we can restore between tests that
  // toggle ATC-specific env vars. The harness itself restores its own
  // captured env on stop().
  const originalAtcEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await stack.start();
    for (const name of [
      "IDEMPOTENCY_TABLE_NAME",
      "CONSUMER_REGISTRY_TABLE_NAME",
      "CATALOG_BUCKET",
      "CATALOG_KEY",
      "EVENT_BUS_NAME",
      "WORKSPACE_ROOT",
      "AGENT_CONFIG_PATH",
    ]) {
      originalAtcEnv[name] = process.env[name];
    }
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(originalAtcEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await stack.stop();
  });

  beforeEach(() => {
    // Clear ATC env between tests so each test's setup is explicit.
    for (const name of Object.keys(originalAtcEnv)) {
      delete process.env[name];
    }
  });

  async function buildAtcStack(): Promise<{
    handler: Awaited<ReturnType<typeof createAtcLambdaHandler>>;
    fakeRunner: FakeCodingAgentRunner;
    secretValue: string;
    replyQueueUrl: string;
    eventCaptureQueueUrl: string;
    idempotencyTable: string;
    consumerId: string;
  }> {
    // ---- Provision LocalStack resources for one fresh ATC stack ----
    const idempotencyTable = await stack.createIdempotencyTable("atc-idem");
    const consumerRegistryTable = await stack.createConsumerRegistryTable("atc-consumers");
    const bucket = await stack.createBucket("atc-catalog");
    const eventBus = await stack.createEventBus("atc-events");
    const replyQueue = await stack.createQueue("atc-reply");

    // ---- Publish a small catalog (one ATC-enabled project) ----
    const project: Project = {
      id: "demo",
      source: { url: "https://example.invalid/demo.git", branch: "main" },
      description: "Demo project for end-to-end test",
      extensions: { atc: { enabled: true } },
    };
    await publishCatalog({
      bucket,
      key: "catalog.json",
      projects: [project],
      client: stack.s3Client(),
    });

    // ---- Register a consumer with ssm-parameter signing key ----
    const secretValue = "e2e-test-hmac-key";
    const signingKeyParam = await stack.createSecureStringParameter(
      `/leanish/test/${stack.id}/atc-hmac`,
      secretValue,
    );
    const dynamo = stack.dynamoClient();
    const { DynamoConsumerRegistry } = await import("@leanish/runtime");
    const registry = new DynamoConsumerRegistry({
      tableName: consumerRegistryTable,
      client: dynamo,
    });
    const consumerId = "atc-ui";
    await registry.put({
      consumerId,
      signingKey: { kind: "ssm-parameter", name: signingKeyParam },
      allowedKinds: ["ask"],
    });

    // ---- Subscribe an SQS queue to the event bus so we can assert events ----
    const eventCaptureQueue = await stack.createQueue("atc-events-cap");
    await attachSqsTargetToEventBus(stack, eventBus, eventCaptureQueue.queueArn, eventCaptureQueue.queueUrl);

    // ---- Set the env vars createAtcLambdaHandler reads ----
    process.env["IDEMPOTENCY_TABLE_NAME"] = idempotencyTable;
    process.env["CONSUMER_REGISTRY_TABLE_NAME"] = consumerRegistryTable;
    process.env["CATALOG_BUCKET"] = bucket;
    process.env["EVENT_BUS_NAME"] = eventBus;
    // Skip the working-copy git clone path entirely — the demo project has
    // a fake URL; we rely on the test always using `noSync: true` in the
    // request payload so syncWorkingCopies isn't called.
    process.env["WORKSPACE_ROOT"] = "/tmp/atc-e2e-workspace";

    // ---- Wire a FakeCodingAgentRunner so we don't need the live CLI ----
    const fakeRunner = new FakeCodingAgentRunner("claude-code", [
      {
        entrypoint: "ask",
        respond: (invocation) => ({
          responseText: [
            "<thinking>Answering via FakeCodingAgentRunner.</thinking>",
            "",
            "```json",
            JSON.stringify({
              answer: `End-to-end fake answer (entrypoint=${invocation.entrypoint.name}, args=${invocation.renderedArguments.slice(0, 60)})`,
            }),
            "```",
          ].join("\n"),
        }),
      },
    ]);

    const handler = await createAtcLambdaHandler({
      runners: new Map([["claude-code", fakeRunner]]),
    });

    return {
      handler,
      fakeRunner,
      secretValue,
      replyQueueUrl: replyQueue.queueUrl,
      eventCaptureQueueUrl: eventCaptureQueue.queueUrl,
      idempotencyTable,
      consumerId,
    };
  }

  it("ATC handles one signed envelope: skill runs, terminal reply lands on reply queue", async () => {
    const ctx = await buildAtcStack();

    const requestId = `req-${Date.now()}`;
    const envelope = makeSignedEnvelope({
      consumer: ctx.consumerId,
      kind: "ask",
      endUser: "u:e2e",
      requestId,
      replyTo: arnFromQueueUrl(ctx.replyQueueUrl),
      payload: {
        question: "what does the demo project do?",
        audience: "codebase",
        includeAll: true,
        noSync: true, // avoid the real git clone path
      },
      secret: ctx.secretValue,
    });

    const sqsEvent = {
      Records: [
        {
          messageId: requestId,
          body: JSON.stringify(envelope),
        },
      ],
    };

    const result = await ctx.handler(sqsEvent);

    // 1. The shim reports the record handled (no SQS keeping).
    expect(result.batchItemFailures).toHaveLength(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("handled");

    // 2. The fake runner saw the ask invocation.
    expect(ctx.fakeRunner.invocations).toHaveLength(1);
    expect(ctx.fakeRunner.invocations[0]?.entrypoint.name).toBe("ask");

    // 3. The terminal reply arrived on the reply queue.
    const replies = await stack.readMessages(ctx.replyQueueUrl, {
      maxMessages: 1,
      timeoutMs: 10_000,
    });
    expect(replies).toHaveLength(1);
    const reply = JSON.parse(replies[0]!.body) as AtcTerminalReply;
    expect(reply.status).toBe("completed");
    if (reply.status === "completed") {
      expect(reply.result.answer).toContain("End-to-end fake answer");
      expect(reply.result.projectScope.projects[0]?.id).toBe("demo");
      expect(reply.result.agent.kind).toBe("claude-code");
    }

    // 4. The idempotency record landed as `completed`.
    const idem = await stack.dynamoClient().send(
      new GetItemCommand({
        TableName: ctx.idempotencyTable,
        Key: { pk: { S: requestId } },
        ConsistentRead: true,
      }),
    );
    expect(idem.Item).toBeDefined();
    expect(idem.Item?.["status"]?.S).toBe("completed");
  });

  it("ATC dedupes same MessageId: second delivery returns duplicate-completed, no second skill run", async () => {
    const ctx = await buildAtcStack();

    const requestId = `req-dup-${Date.now()}`;
    const envelope = makeSignedEnvelope({
      consumer: ctx.consumerId,
      kind: "ask",
      endUser: "u:e2e",
      requestId,
      replyTo: arnFromQueueUrl(ctx.replyQueueUrl),
      payload: { question: "dup q", audience: "general", includeAll: true, noSync: true },
      secret: ctx.secretValue,
    });
    const sqsEvent = {
      Records: [{ messageId: requestId, body: JSON.stringify(envelope) }],
    };

    const first = await ctx.handler(sqsEvent);
    expect(first.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(1);

    // Second delivery — same MessageId — should short-circuit.
    const second = await ctx.handler(sqsEvent);
    expect(second.results[0]?.status).toBe("duplicate-completed");
    expect(ctx.fakeRunner.invocations).toHaveLength(1); // NOT 2 — skill not re-run.
  });

  it("ATC emits ask.started + ask.completed lifecycle events to EventBridge", async () => {
    const ctx = await buildAtcStack();

    const requestId = `req-lc-${Date.now()}`;
    const envelope = makeSignedEnvelope({
      consumer: ctx.consumerId,
      kind: "ask",
      endUser: "u:lc",
      requestId,
      replyTo: arnFromQueueUrl(ctx.replyQueueUrl),
      payload: { question: "lifecycle?", audience: "general", includeAll: true, noSync: true },
      secret: ctx.secretValue,
    });

    await ctx.handler({ Records: [{ messageId: requestId, body: JSON.stringify(envelope) }] });

    // EventBridge → SQS target delivery is eventually-consistent on
    // LocalStack; poll for up to ~10s.
    const events = await stack.readMessages(ctx.eventCaptureQueueUrl, {
      maxMessages: 10,
      timeoutMs: 10_000,
    });
    const detailTypes = events
      .map((e) => {
        try {
          return JSON.parse(e.body)["detail-type"] as string | undefined;
        } catch {
          return undefined;
        }
      })
      .filter((t): t is string => t !== undefined);

    expect(detailTypes).toContain("atc.ask.started");
    expect(detailTypes).toContain("atc.ask.completed");
  });

  it("ATC rejects envelope with bad signature (DLQ via maxReceiveCount path)", async () => {
    const ctx = await buildAtcStack();

    const requestId = `req-bad-${Date.now()}`;
    const envelope = makeSignedEnvelope({
      consumer: ctx.consumerId,
      kind: "ask",
      endUser: "u:bad",
      requestId,
      replyTo: arnFromQueueUrl(ctx.replyQueueUrl),
      payload: { question: "?", audience: "general", includeAll: true, noSync: true },
      secret: "WRONG-SECRET",
    });

    const result = await ctx.handler({
      Records: [{ messageId: requestId, body: JSON.stringify(envelope) }],
    });

    // The shim reports `envelope-rejected` and surfaces as batchItemFailures
    // so SQS keeps the message (DLQ via maxReceiveCount).
    expect(result.results[0]?.status).toBe("envelope-rejected");
    expect(result.batchItemFailures).toHaveLength(1);
    // Fake runner was NOT invoked.
    expect(ctx.fakeRunner.invocations).toHaveLength(0);
  });
});

// ----------------------------- helpers -----------------------------

function makeSignedEnvelope(args: {
  consumer: string;
  kind: string;
  endUser: string;
  requestId: string;
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
    requestId: args.requestId,
    consumer: args.consumer,
    endUser: args.endUser,
    timestamp,
    payload: args.payload,
    signature,
    ...(args.conversationKey !== undefined ? { conversationKey: args.conversationKey } : {}),
    ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
  };
}
function arnFromQueueUrl(queueUrl: string): string {
  // LocalStack SQS URLs are like http://localhost:4566/000000000000/<name>
  // ARN form: arn:aws:sqs:<region>:<account>:<name>
  const url = new URL(queueUrl);
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) {
    throw new Error(`unexpected LocalStack SQS URL shape: ${queueUrl}`);
  }
  const [account, name] = parts;
  return `arn:aws:sqs:us-east-1:${account}:${name}`;
}

async function attachSqsTargetToEventBus(
  stack: LocalStackHarness,
  busName: string,
  queueArn: string,
  queueUrl: string,
): Promise<void> {
  // Open up the queue policy so EventBridge can deliver. LocalStack tends
  // to be permissive here, but production parity is worth a real policy.
  const sqs = stack.sqsClient();
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowEventBridge",
              Effect: "Allow",
              Principal: { Service: "events.amazonaws.com" },
              Action: "sqs:SendMessage",
              Resource: queueArn,
            },
          ],
        }),
      },
    }),
  );

  const eb = stack.eventBridgeClient();
  await eb.send(
    new PutRuleCommand({
      Name: "capture-all",
      EventBusName: busName,
      // Match every event published on this bus (LocalStack honours the
      // empty {} pattern as "everything").
      EventPattern: JSON.stringify({ source: [{ prefix: "" }] }),
      State: "ENABLED",
    }),
  );
  await eb.send(
    new PutTargetsCommand({
      EventBusName: busName,
      Rule: "capture-all",
      Targets: [{ Id: "capture-target", Arn: queueArn }],
    }),
  );
}
