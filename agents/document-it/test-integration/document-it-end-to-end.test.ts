import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GetItemCommand } from "@aws-sdk/client-dynamodb";

import { FakeCodingAgentRunner, LocalStackHarness } from "@leanish/runtime/testing";

import { createDocumentItLambdaHandler } from "../src/lambda.js";

const execFileAsync = promisify(execFile);

/**
 * Composite document-it end-to-end test exercised against real LocalStack.
 *
 * Wiring exercised (all on real AWS SDK calls, all routed to LocalStack):
 *   - Catalog read: real S3 GetObject of the deployed `catalog.json` bundle
 *   - Init fan-out: real SQS SendMessage via `createAwsSelfPublisher`
 *     (the breakdown message physically lands on the agent's input queue)
 *   - Idempotency: real DDB conditional-claim three-state
 *   - Working copy: real `git clone` of a local fixture repo
 *     (`LocalGitWorkspace` under WORKSPACE_ROOT)
 *   - Skill dispatch: FakeCodingAgentRunner (no live CLI binary needed)
 *
 * The two-hop pipeline mirrors production exactly: the infra-provisioned
 * scheduler tick body (stage=init, sourceTrigger=scheduler — byte-shape
 * from infra's `ScheduleTargetInput`) drives the fan-out, and the message
 * that landed on the real queue is then redelivered to the same handler
 * as SQS would, driving the breakdown audit.
 *
 * `stack.start()` below throws `LocalStackUnavailableError` if LocalStack
 * isn't reachable — the integration gate fails loudly rather than
 * silently skipping.
 */
describe("document-it end-to-end against LocalStack", () => {
  const stack = new LocalStackHarness();

  // Snapshot the document-it env vars so each test's setup is explicit and
  // nothing leaks between tests. The harness restores its own captured env
  // (AWS_ENDPOINT_URL etc.) on stop().
  const MANAGED_ENV = [
    "IDEMPOTENCY_TABLE_NAME",
    "CATALOG_BUCKET",
    "CATALOG_KEY",
    "CATALOG_TTL_MS",
    "SELF_QUEUE_URL",
    "SELF_QUEUE_ARN",
    "SCHEDULE_GROUP_NAME",
    "SCHEDULER_ROLE_ARN",
    "WORKSPACE_ROOT",
    "AGENT_CONFIG_PATH",
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  /** Local git repo the opted-in fixture project clones from (file:// URL). */
  let fixtureRepoDir: string;
  const scratchDirs: string[] = [];

  beforeAll(async () => {
    await stack.start();
    for (const name of MANAGED_ENV) {
      originalEnv[name] = process.env[name];
    }
    fixtureRepoDir = await createFixtureRepo();
    scratchDirs.push(fixtureRepoDir);
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of scratchDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    await stack.stop();
  });

  beforeEach(() => {
    for (const name of MANAGED_ENV) {
      delete process.env[name];
    }
  });

  const OPTED_IN_ID = "fixtures/docs-demo";
  const QUIET_ID = "fixtures/quiet";
  const DOC_SET = { space: "DOC", pageIds: ["101"], labels: ["docs-demo"] };

  interface DocumentItTestStack {
    readonly handler: Awaited<ReturnType<typeof createDocumentItLambdaHandler>>;
    readonly fakeRunner: FakeCodingAgentRunner;
    readonly inputQueueUrl: string;
    readonly idempotencyTable: string;
  }

  async function buildDocumentItStack(): Promise<DocumentItTestStack> {
    // ---- Provision LocalStack resources for one fresh document-it stack ----
    const idempotencyTable = await stack.createIdempotencyTable("document-it-idem");
    const bucket = await stack.createBucket("document-it-catalog");
    const inputQueue = await stack.createQueue("document-it-input");
    const scheduleGroup = await stack.createScheduleGroup("document-it-schedules");

    // ---- Publish the catalog bundle (data-format §Deployed shape) ----
    // One strictly opted-in project (cloneable file:// fixture repo), one
    // catalog member without the extension (must NOT be audited), and one
    // explicitly disabled project (filtered by forConsumer already).
    const bundle = {
      version: "1",
      projects: [
        {
          id: OPTED_IN_ID,
          source: { url: `file://${fixtureRepoDir}`, branch: "main" },
          extensions: { "document-it": { enabled: true, docSet: DOC_SET } },
          description: "Opted-in fixture project for the document-it e2e test",
        },
        {
          id: QUIET_ID,
          source: { url: "https://example.invalid/quiet.git", branch: "main" },
          extensions: {},
        },
        {
          id: "fixtures/legacy",
          source: { url: "https://example.invalid/legacy.git", branch: "main" },
          extensions: { "document-it": { enabled: false } },
        },
      ],
    };
    await stack.putObject(bucket, "catalog.json", JSON.stringify(bundle), "application/json");

    // ---- Set the env vars createDocumentItLambdaHandler reads ----
    const workspaceRoot = await mkdtemp(join(tmpdir(), "document-it-e2e-ws-"));
    scratchDirs.push(workspaceRoot);
    process.env["IDEMPOTENCY_TABLE_NAME"] = idempotencyTable;
    process.env["CATALOG_BUCKET"] = bucket;
    process.env["SELF_QUEUE_URL"] = inputQueue.queueUrl;
    process.env["SELF_QUEUE_ARN"] = inputQueue.queueArn;
    process.env["SCHEDULE_GROUP_NAME"] = scheduleGroup;
    // publishDelayed is unused by document-it; the publisher only needs a
    // syntactically valid role ARN (same stance as the runtime's own
    // self-publish integration test).
    process.env["SCHEDULER_ROLE_ARN"] = "arn:aws:iam::000000000000:role/scheduler-send";
    process.env["WORKSPACE_ROOT"] = workspaceRoot;

    // ---- Wire a FakeCodingAgentRunner so we don't need the live CLI ----
    const fakeRunner = new FakeCodingAgentRunner("claude-code", [
      {
        entrypoint: "verify-docs",
        respond: () => ({
          responseText: [
            "```json",
            JSON.stringify({
              summary: "Audited README.md against the code; 1 stale claim corrected.",
              inRepoDrift: [
                {
                  type: "stale",
                  location: "README.md#requirements",
                  claim: "Requires Node 18.",
                  correction: "Requires Node 24.",
                  confidence: 0.9,
                },
              ],
              publishedDrift: [],
            }),
            "```",
          ].join("\n"),
        }),
      },
    ]);

    const handler = await createDocumentItLambdaHandler({
      runners: new Map([["claude-code", fakeRunner]]),
    });

    return { handler, fakeRunner, inputQueueUrl: inputQueue.queueUrl, idempotencyTable };
  }

  /** The exact wire shape infra's recurring tick delivers (`ScheduleTargetInput`). */
  function schedulerTickBody(): string {
    return JSON.stringify({
      stage: "init",
      payload: {},
      metadata: { sourceTrigger: "scheduler" },
    });
  }

  /** A self-published breakdown body, as `createAwsSelfPublisher` serialises it. */
  function breakdownBody(payload: Record<string, unknown>): string {
    return JSON.stringify({
      stage: "breakdown",
      payload,
      metadata: {
        sourceTrigger: "self",
        requestId: `prov-${Date.now()}`,
        publishedAt: new Date().toISOString(),
      },
    });
  }

  it("runs the full two-hop pipeline: scheduler tick → fan-out on the real queue → breakdown audit with a real git clone", async () => {
    const ctx = await buildDocumentItStack();

    // ---- Hop 1: the infra-provisioned scheduler tick fires stage=init ----
    const tickId = `tick-${Date.now()}`;
    const tickResult = await ctx.handler({
      Records: [{ messageId: tickId, body: schedulerTickBody() }],
    });
    expect(tickResult.batchItemFailures).toHaveLength(0);
    expect(tickResult.results[0]?.status).toBe("handled");
    // Init only fans out — no skill run yet.
    expect(ctx.fakeRunner.invocations).toHaveLength(0);

    // Exactly ONE breakdown message landed on the agent's own input queue:
    // the strictly opted-in project. The no-extension catalog member
    // survives the default-on consumer view but MUST fail the strict
    // enabled === true filter.
    const landed = await stack.readMessages(ctx.inputQueueUrl, { timeoutMs: 10_000 });
    expect(landed).toHaveLength(1);
    const fanOut = JSON.parse(landed[0]!.body) as {
      stage: string;
      payload: Record<string, unknown>;
      metadata: { sourceTrigger: string; requestId: string; publishedAt: string };
    };
    expect(fanOut.stage).toBe("breakdown");
    expect(fanOut.payload).toEqual({ projectId: OPTED_IN_ID });
    expect(fanOut.metadata.sourceTrigger).toBe("self");
    expect(Date.parse(fanOut.metadata.publishedAt)).not.toBeNaN();

    // ---- Hop 2: SQS redelivers the landed message to the same Lambda ----
    const breakdownRecord = { messageId: landed[0]!.messageId, body: landed[0]!.body };
    const breakdownResult = await ctx.handler({ Records: [breakdownRecord] });
    expect(breakdownResult.batchItemFailures).toHaveLength(0);
    expect(breakdownResult.results[0]?.status).toBe("handled");

    // The fake runner saw exactly one verify-docs invocation, mounted on a
    // REAL git clone of the fixture repo under WORKSPACE_ROOT.
    expect(ctx.fakeRunner.invocations).toHaveLength(1);
    const invocation = ctx.fakeRunner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("verify-docs");
    expect(invocation.workingCopies).toHaveLength(1);
    const workingCopy = invocation.workingCopies[0]!;
    expect(workingCopy.projectId).toBe(OPTED_IN_ID);
    expect(existsSync(join(workingCopy.path, "README.md"))).toBe(true);

    // The rendered skill input carries the project source and the docSet
    // from extensions["document-it"].docSet verbatim.
    expect(invocation.renderedArguments).toContain(`id: ${OPTED_IN_ID}`);
    expect(invocation.renderedArguments).toContain("space: DOC");
    expect(invocation.renderedArguments).toContain('- "101"');
    expect(invocation.renderedArguments).toContain("- docs-demo");

    // Both hops finalised their idempotency rows as `completed` in real DDB.
    for (const messageId of [tickId, breakdownRecord.messageId]) {
      const row = await stack.dynamoClient().send(
        new GetItemCommand({
          TableName: ctx.idempotencyTable,
          Key: { pk: { S: messageId } },
          ConsistentRead: true,
        }),
      );
      expect(row.Item?.["status"]?.S).toBe("completed");
    }
  });

  it("dedupes SQS redelivery of the same MessageId: duplicate-completed, no second skill run", async () => {
    const ctx = await buildDocumentItStack();

    const record = {
      messageId: `bd-dup-${Date.now()}`,
      body: breakdownBody({ projectId: OPTED_IN_ID }),
    };

    const first = await ctx.handler({ Records: [record] });
    expect(first.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(1);

    // At-least-once redelivery — the real DDB conditional write reports the
    // prior completion; the audit is NOT re-run.
    const second = await ctx.handler({ Records: [record] });
    expect(second.results[0]?.status).toBe("duplicate-completed");
    expect(second.batchItemFailures).toHaveLength(0);
    expect(ctx.fakeRunner.invocations).toHaveLength(1);
  });

  it("skips the audit (and still ACKs) for a catalog project that is not explicitly opted in", async () => {
    const ctx = await buildDocumentItStack();

    const result = await ctx.handler({
      Records: [
        { messageId: `bd-quiet-${Date.now()}`, body: breakdownBody({ projectId: QUIET_ID }) },
      ],
    });

    // Skip-not-retry: the message is handled (ACKed), no DLQ churn, and the
    // write-capable skill never ran for the non-opted-in project.
    expect(result.results[0]?.status).toBe("handled");
    expect(result.batchItemFailures).toHaveLength(0);
    expect(ctx.fakeRunner.invocations).toHaveLength(0);
  });

  it("drops (ACKs) a malformed breakdown payload with no projectId — redelivery cannot fix it", async () => {
    const ctx = await buildDocumentItStack();

    const result = await ctx.handler({
      Records: [{ messageId: `bd-bad-${Date.now()}`, body: breakdownBody({}) }],
    });

    expect(result.results[0]?.status).toBe("handled");
    expect(result.batchItemFailures).toHaveLength(0);
    expect(ctx.fakeRunner.invocations).toHaveLength(0);
  });

  it("rejects a stage outside the declared [init, breakdown] set (DLQ via maxReceiveCount path)", async () => {
    const ctx = await buildDocumentItStack();

    const body = JSON.stringify({
      stage: "revisit",
      payload: { projectId: OPTED_IN_ID },
      metadata: {
        sourceTrigger: "self",
        requestId: "prov-revisit",
        publishedAt: new Date().toISOString(),
      },
    });
    const result = await ctx.handler({
      Records: [{ messageId: `bd-revisit-${Date.now()}`, body }],
    });

    // The shim reports `runtime-message-rejected` and surfaces it as a
    // batchItemFailure so SQS keeps the message (DLQ via maxReceiveCount).
    expect(result.results[0]?.status).toBe("runtime-message-rejected");
    expect(result.batchItemFailures).toHaveLength(1);
    expect(ctx.fakeRunner.invocations).toHaveLength(0);
  });
});

// ----------------------------- helpers -----------------------------

/**
 * Create a tiny local git repo (file:// cloneable) with one README commit,
 * so `LocalGitWorkspace.sync` exercises a REAL `git clone` without any
 * network dependency.
 */
async function createFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "document-it-e2e-repo-"));
  await git(dir, "init", "-b", "main");
  await writeFile(
    join(dir, "README.md"),
    "# docs-demo\n\nRequires Node 18.\n", // a deliberately stale claim for the audit to chew on
    "utf8",
  );
  await git(dir, "add", "README.md");
  await git(
    dir,
    "-c",
    "user.email=e2e@example.invalid",
    "-c",
    "user.name=document-it e2e",
    "commit",
    "-m",
    "fixture: initial docs",
  );
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
