import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { publishCatalog, type Project } from "@leanish/catalog-it";
import { DynamoConsumerRegistry, verifyEnvelope } from "@leanish/runtime";
import { FakeCodingAgentRunner, LocalStackHarness } from "@leanish/runtime/testing";
import { parseShipItRequest } from "@leanish/ship-it";
// The real downstream consumer: feeding the queue message through
// ship-it's actual Lambda handler is what pins the producer/consumer
// envelope contract end to end (consumer id, kind, signature, payload).
import { createShipItLambdaHandler } from "@leanish/ship-it/lambda";

import { createNormalizerLambdaHandler } from "../src/lambda.js";
import type { FunctionUrlEvent } from "../src/http.js";

/** Every env var the normalizer and ship-it Lambda factories read. */
const ENV_NAMES = [
  // normalizer
  "GITHUB_WEBHOOK_SECRET",
  "JIRA_WEBHOOK_SECRET",
  "ENVELOPE_SIGNING_KEY",
  "SHIP_IT_QUEUE_URL",
  "CATALOG_BUCKET",
  "CATALOG_KEY",
  "JIRA_PROJECT_MAP",
  "JIRA_ACCEPTANCE_FIELD",
  // ship-it (the downstream-handoff test)
  "IDEMPOTENCY_TABLE_NAME",
  "CONSUMER_REGISTRY_TABLE_NAME",
  "SELF_QUEUE_URL",
  "SELF_QUEUE_ARN",
  "SCHEDULE_GROUP_NAME",
  "SCHEDULER_ROLE_ARN",
  "WORKSPACE_ROOT",
  "AGENT_CONFIG_PATH",
] as const;

const GITHUB_SECRET = "e2e-github-webhook-secret";
const JIRA_SECRET = "e2e-jira-shared-secret";

/**
 * Webhook → gate → signed envelope → REAL SQS, against LocalStack, on the
 * full production wiring (`createNormalizerLambdaHandler` with zero
 * injection: real `S3Catalog.load`, real `SQSClient`):
 *
 *   - an admitted, correctly HMAC-signed GitHub delivery lands on the
 *     queue as a `ship-it-event` envelope that `verifyEnvelope` accepts
 *     against a REAL ConsumerRegistry read (DynamoDB);
 *   - bad signatures bounce with 401, filtered events with 204, duplicate
 *     deliveries with 200 — and none of them reach the queue;
 *   - a Jira-admitted ticket flows all the way INTO ship-it's real Lambda
 *     consumer (DDB registry + SSM SecureString signing key resolved by
 *     ship-it's own resolver) and executes the released groom-it step.
 *
 * `stack.start()` throws `LocalStackUnavailableError` if LocalStack isn't
 * reachable — the integration gate fails loudly rather than silently
 * skipping.
 */
describe("ship-it-normalizer webhook end-to-end against LocalStack", () => {
  const stack = new LocalStackHarness();
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await stack.start();
    for (const name of ENV_NAMES) {
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
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
  });

  interface NormalizerStackContext {
    readonly queueUrl: string;
    readonly queueArn: string;
    readonly catalogBucket: string;
    /** Raw signing-key string; `ENVELOPE_SIGNING_KEY` carries its base64 form. */
    readonly signingSecret: string;
    readonly handler: Awaited<ReturnType<typeof createNormalizerLambdaHandler>>;
  }

  async function provisionNormalizerStack(): Promise<NormalizerStackContext> {
    const queue = await stack.createQueue("normalizer-out");
    const catalogBucket = await stack.createBucket("normalizer-catalog");

    const projects: Project[] = [
      {
        id: "acme/widgets",
        // Never cloned here: the normalizer reads only the catalog gate,
        // and the downstream groom-it step is ticket-only.
        source: { url: "https://git.invalid/acme/widgets.git", branch: "main" },
        extensions: { "ship-it": { enabled: true } },
      },
      {
        id: "acme/implicit",
        source: { url: "https://git.invalid/acme/implicit.git", branch: "main" },
        extensions: {},
      },
    ];
    await publishCatalog({
      bucket: catalogBucket,
      key: "catalog.json",
      projects,
      client: stack.s3Client(),
    });

    const signingSecret = `normalizer-e2e-key-${stack.id}`;
    process.env["GITHUB_WEBHOOK_SECRET"] = GITHUB_SECRET;
    process.env["JIRA_WEBHOOK_SECRET"] = JIRA_SECRET;
    process.env["ENVELOPE_SIGNING_KEY"] = Buffer.from(signingSecret, "utf8").toString("base64");
    process.env["SHIP_IT_QUEUE_URL"] = queue.queueUrl;
    process.env["CATALOG_BUCKET"] = catalogBucket;
    process.env["JIRA_PROJECT_MAP"] = JSON.stringify({ ABC: "acme/widgets" });
    process.env["JIRA_ACCEPTANCE_FIELD"] = "customfield_10042";

    const handler = await createNormalizerLambdaHandler({});
    return {
      queueUrl: queue.queueUrl,
      queueArn: queue.queueArn,
      catalogBucket,
      signingSecret,
      handler,
    };
  }

  function githubSignature(raw: Buffer): string {
    return "sha256=" + createHmac("sha256", GITHUB_SECRET).update(raw).digest("hex");
  }

  function githubEvent(
    body: unknown,
    options: { signature?: string; deliveryId?: string } = {},
  ): FunctionUrlEvent {
    const raw = Buffer.from(JSON.stringify(body), "utf8");
    return {
      rawPath: "/github",
      headers: {
        "x-hub-signature-256": options.signature ?? githubSignature(raw),
        "x-github-delivery": options.deliveryId ?? randomUUID(),
      },
      // Lambda Function URLs deliver webhook bodies base64-encoded; use
      // the production shape so signature verification proves it decodes
      // the EXACT raw bytes first.
      body: raw.toString("base64"),
      isBase64Encoded: true,
    };
  }

  function jiraEvent(body: unknown): FunctionUrlEvent {
    return {
      rawPath: "/jira",
      headers: { "x-leanish-webhook-secret": JIRA_SECRET },
      body: JSON.stringify(body),
      isBase64Encoded: false,
    };
  }

  function prBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      action: "ready_for_review",
      pull_request: {
        number: 7,
        title: "ABC-123: implement the widget",
        draft: false,
        head: { ref: "ship-it/ABC-123" },
      },
      repository: { full_name: "acme/widgets" },
      sender: { login: "octocat" },
      ...overrides,
    };
  }

  it("admitted GitHub webhook → 202; the envelope on the REAL queue verifies via a real ConsumerRegistry read", async () => {
    const ctx = await provisionNormalizerStack();

    const response = await ctx.handler(githubEvent(prBody(), { deliveryId: "gh-e2e-1" }));
    expect(response.statusCode).toBe(202);

    const messages = await stack.readMessages(ctx.queueUrl, { maxMessages: 1, timeoutMs: 10_000 });
    expect(messages).toHaveLength(1);
    const envelope = JSON.parse(messages[0]!.body) as Record<string, unknown>;

    // Real consumer-registry read: the record lives in DynamoDB exactly as
    // the deploy-time bootstrap writes it (README §ConsumerRegistry).
    const registryTable = await stack.createConsumerRegistryTable("normalizer-consumers");
    const registry = new DynamoConsumerRegistry({
      tableName: registryTable,
      client: stack.dynamoClient(),
    });
    await registry.put({
      consumerId: "webhook-normalizer",
      signingKey: {
        kind: "literal",
        base64: Buffer.from(ctx.signingSecret, "utf8").toString("base64"),
      },
      allowedKinds: ["ship-it-event"],
    });

    const verified = await verifyEnvelope({ envelope, consumerRegistry: registry });
    expect(verified.kind).toBe("ship-it-event");
    expect(verified.consumer).toBe("webhook-normalizer");
    expect(verified.requestId).toBe("gh-e2e-1");
    expect(verified.endUser).toBe("github:octocat");

    const request = parseShipItRequest(verified.payload);
    expect(request.ticketKey).toBe("ABC-123");
    expect(request.projectId).toBe("acme/widgets");
    expect(request.prNumber).toBe(7);
    expect(request.trigger).toEqual({ source: "github", mode: "pull-request" });
  });

  it("a tampered body is rejected with 401 and nothing reaches the queue", async () => {
    const ctx = await provisionNormalizerStack();

    const signatureForOriginal = githubSignature(Buffer.from(JSON.stringify(prBody()), "utf8"));
    const tampered = githubEvent(prBody({ sender: { login: "mallory" } }), {
      signature: signatureForOriginal,
    });
    const response = await ctx.handler(tampered);

    expect(response.statusCode).toBe(401);
    expect(await stack.readMessages(ctx.queueUrl, { timeoutMs: 2_000 })).toHaveLength(0);
  });

  it("filtered events answer 204 and never reach the queue (gate, not error)", async () => {
    const ctx = await provisionNormalizerStack();

    // Repo present in the catalog but with no explicit ship-it opt-in.
    const notOptedIn = await ctx.handler(
      githubEvent(prBody({ repository: { full_name: "acme/implicit" } })),
    );
    expect(notOptedIn.statusCode).toBe(204);

    // Unsupported PR action.
    const unsupported = await ctx.handler(githubEvent(prBody({ action: "opened" })));
    expect(unsupported.statusCode).toBe(204);

    expect(await stack.readMessages(ctx.queueUrl, { timeoutMs: 2_000 })).toHaveLength(0);
  });

  it("a duplicate delivery id answers 200 deduped; exactly one envelope is sent", async () => {
    const ctx = await provisionNormalizerStack();
    const event = githubEvent(prBody(), { deliveryId: "gh-e2e-dup" });

    expect((await ctx.handler(event)).statusCode).toBe(202);
    const second = await ctx.handler(event);
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body ?? "{}")).toEqual({ deduped: true });

    expect(await stack.readMessages(ctx.queueUrl, { timeoutMs: 5_000 })).toHaveLength(1);
  });

  it("a Jira-admitted ticket flows through the REAL ship-it Lambda consumer and runs groom-it", async () => {
    const ctx = await provisionNormalizerStack();

    // --- provision ship-it's side of the contract ---
    const idempotencyTable = await stack.createIdempotencyTable("handoff-idem");
    const consumerRegistryTable = await stack.createConsumerRegistryTable("handoff-consumers");
    const scheduleGroup = await stack.createScheduleGroup("handoff-schedules");
    // Deployment-shaped record: the signing key lives in SSM as a
    // SecureString; ship-it resolves it with its own signing-key resolver.
    const parameterName = await stack.createSecureStringParameter(
      `/leanish/test/${stack.id}/handoff-normalizer-hmac`,
      ctx.signingSecret,
    );
    const registry = new DynamoConsumerRegistry({
      tableName: consumerRegistryTable,
      client: stack.dynamoClient(),
    });
    await registry.put({
      consumerId: "webhook-normalizer",
      signingKey: { kind: "ssm-parameter", name: parameterName },
      allowedKinds: ["ship-it-event"],
    });

    process.env["IDEMPOTENCY_TABLE_NAME"] = idempotencyTable;
    process.env["CONSUMER_REGISTRY_TABLE_NAME"] = consumerRegistryTable;
    process.env["SELF_QUEUE_URL"] = ctx.queueUrl;
    process.env["SELF_QUEUE_ARN"] = ctx.queueArn;
    process.env["SCHEDULE_GROUP_NAME"] = scheduleGroup;
    process.env["SCHEDULER_ROLE_ARN"] = "arn:aws:iam::000000000000:role/scheduler-send";
    process.env["WORKSPACE_ROOT"] = mkdtempSync(join(tmpdir(), "handoff-workspace-"));
    // CATALOG_BUCKET is already set — both Lambdas read the same catalog.

    const runner = new FakeCodingAgentRunner("claude-code");
    runner.register("groom-it", () => ({
      responseText:
        "```json\n" +
        JSON.stringify({ outcome: "ready", findings: [], notes: "ticket meets the bar" }) +
        "\n```",
    }));
    const shipItHandler = await createShipItLambdaHandler({
      runners: new Map([["claude-code", runner]]),
    });

    // --- the webhook: a labeled ticket in the groom-it status ---
    const response = await ctx.handler(
      jiraEvent({
        id: "jira-evt-handoff-1",
        webhookEvent: "jira:issue_updated",
        user: { accountId: "557058:e2e" },
        issue: {
          key: "ABC-321",
          fields: {
            project: { key: "ABC" },
            status: { name: "To Groom" },
            labels: ["ship-it"],
            summary: "Tighten the widget copy",
            description: "The dashboard copy is unclear.",
            customfield_10042: ["copy reads naturally"],
          },
        },
      }),
    );
    expect(response.statusCode).toBe(202);

    // --- the handoff: the queue message through ship-it's real handler ---
    const messages = await stack.readMessages(ctx.queueUrl, { maxMessages: 1, timeoutMs: 10_000 });
    expect(messages).toHaveLength(1);
    const result = await shipItHandler({
      Records: [{ messageId: messages[0]!.messageId, body: messages[0]!.body }],
    });

    expect(result.batchItemFailures).toHaveLength(0);
    expect(result.results[0]?.status).toBe("handled");
    expect(runner.invocations).toHaveLength(1);
    const invocation = runner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("groom-it");
    expect(invocation.workingCopies).toEqual([]);
    expect(invocation.renderedArguments).toContain("ticketKey: ABC-321");
    expect(invocation.renderedArguments).toContain("copy reads naturally");
  });
});
