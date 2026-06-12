import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GetItemCommand } from "@aws-sdk/client-dynamodb";

import { canonicalize, DynamoConsumerRegistry } from "@leanish/runtime";
import { FakeCodingAgentRunner, LocalStackHarness } from "@leanish/runtime/testing";

import { EVIDENCE_MOUNT_ID } from "../src/handler.js";
import { createTriageItLambdaHandler } from "../src/lambda.js";
import type { TriageTerminalReply } from "../src/terminal-reply.js";
import { makeTarGz } from "../test/helpers/tar-fixture.js";

/**
 * Composite triage-it end-to-end suite against real LocalStack.
 *
 * Wiring exercised (all real AWS SDK calls, all routed to LocalStack):
 *   - Envelope verification: real DDB ConsumerRegistry + real SSM Parameter Store
 *   - Idempotency: real DDB conditional-claim three-state
 *   - Evidence fetch: real S3 GetObject of the collector's tar.gz blob
 *   - Evidence extraction: the real safe-extraction path (caps + rejection)
 *   - Skill dispatch: FakeCodingAgentRunner (no live CLI binary needed)
 *   - Terminal reply: real SQS SendMessage to envelope.replyTo
 *   - Catalog read + working-copy sync: real S3 catalog.json + a local git repo
 *
 * `stack.start()` throws `LocalStackUnavailableError` when LocalStack isn't
 * reachable — the integration gate fails loudly rather than silently skipping.
 */
describe("triage-it end-to-end against LocalStack", () => {
  const stack = new LocalStackHarness();

  const envVars = [
    "IDEMPOTENCY_TABLE_NAME",
    "CONSUMER_REGISTRY_TABLE_NAME",
    "CATALOG_BUCKET",
    "CATALOG_KEY",
    "EVENT_BUS_NAME",
    "WORKSPACE_ROOT",
    "AGENT_CONFIG_PATH",
    "TRIAGE_IT_TMP_DIR",
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  /** Fresh evidence-extraction base per test so leak assertions are precise. */
  let evidenceTmpBase: string;

  beforeAll(async () => {
    await stack.start();
    for (const name of envVars) {
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

  beforeEach(async () => {
    for (const name of envVars) {
      delete process.env[name];
    }
    evidenceTmpBase = await mkdtemp(join(tmpdir(), "triage-it-e2e-evidence-"));
    process.env["TRIAGE_IT_TMP_DIR"] = evidenceTmpBase;
  });

  afterEach(async () => {
    await rm(evidenceTmpBase, { recursive: true, force: true });
  });

  const EVIDENCE_ARCHIVE = makeTarGz([
    { path: "manifest.md", content: "# evidence for acme / SUP-42\n\n- config/settings.json\n- stats/summary.json\n" },
    { path: "config/", type: "5" },
    { path: "config/settings.json", content: '{"feature":{"enabled":false}}' },
    { path: "stats/summary.json", content: '{"impressions":0,"since":"2026-06-09"}' },
  ]);

  interface TriageStack {
    readonly handler: Awaited<ReturnType<typeof createTriageItLambdaHandler>>;
    readonly fakeRunner: FakeCodingAgentRunner;
    readonly secretValue: string;
    readonly evidenceBucket: string;
    readonly replyQueueUrl: string;
    readonly idempotencyTable: string;
    readonly consumerId: string;
  }

  /**
   * Provision one fresh triage-it stack on LocalStack: tables, buckets,
   * event bus, reply queue, SSM-backed consumer record, catalog bundle,
   * and a Lambda handler wired to a FakeCodingAgentRunner.
   */
  async function buildTriageStack(options: {
    /** Projects entry for catalog.json (hand-rolled deployed bundle shape). */
    readonly catalogProjects?: ReadonlyArray<Record<string, unknown>>;
  } = {}): Promise<TriageStack> {
    const idempotencyTable = await stack.createIdempotencyTable("triage-it-idem");
    const consumerRegistryTable = await stack.createConsumerRegistryTable("triage-it-consumers");
    const catalogBucket = await stack.createBucket("triage-it-catalog");
    const evidenceBucket = await stack.createBucket("triage-it-evidence");
    const eventBus = await stack.createEventBus("triage-it-events");
    const replyQueue = await stack.createQueue("triage-it-reply");

    // Deployed catalog bundle shape: {"version":"1","projects":[...]}.
    await stack.putObject(
      catalogBucket,
      "catalog.json",
      JSON.stringify({ version: "1", projects: options.catalogProjects ?? [] }),
      "application/json",
    );

    const secretValue = "triage-e2e-hmac-key";
    const signingKeyParam = await stack.createSecureStringParameter(
      `/leanish/test/${stack.id}/triage-it-hmac`,
      secretValue,
    );
    const registry = new DynamoConsumerRegistry({
      tableName: consumerRegistryTable,
      client: stack.dynamoClient(),
    });
    const consumerId = "support-tooling";
    await registry.put({
      consumerId,
      signingKey: { kind: "ssm-parameter", name: signingKeyParam },
      allowedKinds: ["triage"],
    });

    process.env["IDEMPOTENCY_TABLE_NAME"] = idempotencyTable;
    process.env["CONSUMER_REGISTRY_TABLE_NAME"] = consumerRegistryTable;
    process.env["CATALOG_BUCKET"] = catalogBucket;
    process.env["EVENT_BUS_NAME"] = eventBus;
    process.env["WORKSPACE_ROOT"] = join(evidenceTmpBase, "workspaces");

    const fakeRunner = new FakeCodingAgentRunner("claude-code", [
      {
        entrypoint: "triage",
        respond: () => ({
          responseText: [
            "```json",
            JSON.stringify({
              diagnosis: "feature.enabled is false since 2026-06-09; impressions dropped to zero.",
              findings: [
                { category: "config", finding: "feature.enabled is false", confidence: 0.9 },
              ],
              suggestedNextSteps: ["confirm with the customer and re-enable feature.enabled"],
              relevantPriorTickets: [],
            }),
            "```",
          ].join("\n"),
        }),
      },
    ]);

    const handler = await createTriageItLambdaHandler({
      runners: new Map([["claude-code", fakeRunner]]),
    });

    return {
      handler,
      fakeRunner,
      secretValue,
      evidenceBucket,
      replyQueueUrl: replyQueue.queueUrl,
      idempotencyTable,
      consumerId,
    };
  }

  async function uploadEvidence(
    ctx: TriageStack,
    archive: Uint8Array,
    key = "acme/SUP-42.tar.gz",
  ): Promise<string> {
    await stack.putObject(ctx.evidenceBucket, key, archive, "application/gzip");
    return `s3://${ctx.evidenceBucket}/${key}`;
  }

  function sqsEventFor(
    ctx: TriageStack,
    requestId: string,
    request: unknown,
    overrides: { readonly secret?: string } = {},
  ): { Records: Array<{ messageId: string; body: string }> } {
    const envelope = makeSignedEnvelope({
      consumer: ctx.consumerId,
      kind: "triage",
      endUser: "support:e2e",
      requestId,
      replyTo: arnFromQueueUrl(ctx.replyQueueUrl),
      payload: request,
      secret: overrides.secret ?? ctx.secretValue,
    });
    return { Records: [{ messageId: requestId, body: JSON.stringify(envelope) }] };
  }

  async function readReply(ctx: TriageStack): Promise<TriageTerminalReply> {
    const replies = await stack.readMessages(ctx.replyQueueUrl, {
      maxMessages: 1,
      timeoutMs: 10_000,
    });
    expect(replies).toHaveLength(1);
    return JSON.parse(replies[0]!.body) as TriageTerminalReply;
  }

  it("full pipeline: evidence fetched from real S3, extracted, skill run, reply on queue, idempotency completed", async () => {
    const ctx = await buildTriageStack();
    const evidenceBlobUri = await uploadEvidence(ctx, EVIDENCE_ARCHIVE);

    // Capture the on-disk view while the skill runs — extraction must
    // complete before dispatch, and cleanup must happen only after.
    let evidenceDirDuringRun: string | undefined;
    let manifestOnDiskDuringRun = false;
    ctx.fakeRunner.register("triage", (invocation) => {
      evidenceDirDuringRun = /evidenceDir: (\S+)/.exec(invocation.renderedArguments)?.[1];
      if (evidenceDirDuringRun !== undefined) {
        manifestOnDiskDuringRun = existsSync(join(evidenceDirDuringRun, "manifest.md"));
      }
      return {
        responseText: [
          "```json",
          JSON.stringify({
            diagnosis: "grounded diagnosis",
            findings: [{ category: "stats", finding: "impressions are zero", confidence: 0.8 }],
            suggestedNextSteps: ["re-enable the feature flag"],
            relevantPriorTickets: [{ ticketKey: "SUP-7", note: "same flag" }],
          }),
          "```",
        ].join("\n"),
      };
    });

    const requestId = `req-e2e-${Date.now()}`;
    const result = await ctx.handler(
      sqsEventFor(ctx, requestId, {
        ticketKey: "SUP-42",
        customer: "acme",
        evidenceBlobUri,
        problem: "impressions dropped to zero on Tuesday",
      }),
    );

    expect(result.batchItemFailures).toHaveLength(0);
    expect(result.results[0]?.status).toBe("handled");

    // The skill saw a populated evidence dir under the pinned tmp base...
    expect(ctx.fakeRunner.invocations).toHaveLength(1);
    expect(evidenceDirDuringRun).toContain(evidenceTmpBase);
    expect(manifestOnDiskDuringRun).toBe(true);
    // ...mounted as a working copy (evidence-only → it is the spawn cwd;
    // the coding-agent sandbox only reads mounted directories)...
    expect(ctx.fakeRunner.invocations[0]!.workingCopies.map((wc) => wc.projectId)).toEqual([
      EVIDENCE_MOUNT_ID,
    ]);
    expect(ctx.fakeRunner.invocations[0]!.workingCopies[0]!.path).toBe(evidenceDirDuringRun);
    // ...and the whole temp tree is removed once the handler returns.
    expect(existsSync(evidenceDirDuringRun!)).toBe(false);

    const reply = await readReply(ctx);
    expect(reply.status).toBe("completed");
    if (reply.status === "completed") {
      expect(reply.result.diagnosis).toBe("grounded diagnosis");
      expect(reply.result.codeScope).toBe("evidence-only");
      expect(reply.result.agent).toEqual({ kind: "claude-code", model: "claude-sonnet-4-6" });
      expect(reply.result.relevantPriorTickets).toEqual([{ ticketKey: "SUP-7", note: "same flag" }]);
    }

    const idem = await stack.dynamoClient().send(
      new GetItemCommand({
        TableName: ctx.idempotencyTable,
        Key: { pk: { S: requestId } },
        ConsistentRead: true,
      }),
    );
    expect(idem.Item?.["status"]?.S).toBe("completed");
  });

  it("dedupes the same MessageId: second delivery is duplicate-completed, no second skill run", async () => {
    const ctx = await buildTriageStack();
    const evidenceBlobUri = await uploadEvidence(ctx, EVIDENCE_ARCHIVE);
    const requestId = `req-dup-${Date.now()}`;
    const event = sqsEventFor(ctx, requestId, {
      ticketKey: "SUP-42",
      customer: "acme",
      evidenceBlobUri,
    });

    const first = await ctx.handler(event);
    expect(first.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(1);

    const second = await ctx.handler(event);
    expect(second.results[0]?.status).toBe("duplicate-completed");
    expect(ctx.fakeRunner.invocations).toHaveLength(1); // NOT 2 — skill not re-run.
  });

  it("code+evidence: explicit projectIds sync a real git working copy from the S3 catalog", async () => {
    // A real local git repo stands in for the project source — the clone
    // goes through the same LocalGitWorkspace path as a remote URL.
    const repoDir = await mkdtemp(join(evidenceTmpBase, "project-repo-"));
    execFileSync("git", ["init", "--quiet", "-b", "main", repoDir]);
    await writeFile(join(repoDir, "consumer.txt"), "decode loop lives here\n");
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@test.invalid",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@test.invalid",
    };
    execFileSync("git", ["-C", repoDir, "add", "."], { env: gitEnv });
    execFileSync("git", ["-C", repoDir, "commit", "--quiet", "-m", "seed"], { env: gitEnv });

    const projectId = "leanish/demo-consumer";
    const ctx = await buildTriageStack({
      catalogProjects: [
        {
          id: projectId,
          source: { url: repoDir, branch: "main" },
          extensions: {},
        },
      ],
    });
    const evidenceBlobUri = await uploadEvidence(ctx, EVIDENCE_ARCHIVE);

    let workingCopyPathDuringRun: string | undefined;
    ctx.fakeRunner.register("triage", (invocation) => {
      workingCopyPathDuringRun = invocation.workingCopies[0]?.path;
      return {
        responseText: [
          "```json",
          JSON.stringify({
            diagnosis: "code-scoped diagnosis",
            findings: [],
            suggestedNextSteps: [],
            relevantPriorTickets: [],
          }),
          "```",
        ].join("\n"),
      };
    });

    const result = await ctx.handler(
      sqsEventFor(ctx, `req-code-${Date.now()}`, {
        ticketKey: "SUP-43",
        customer: "acme",
        evidenceBlobUri,
        projectIds: [projectId],
      }),
    );

    expect(result.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(1);
    // Project working copy first (spawn cwd), evidence mount last.
    expect(ctx.fakeRunner.invocations[0]!.workingCopies.map((wc) => wc.projectId)).toEqual([
      projectId,
      EVIDENCE_MOUNT_ID,
    ]);
    // The synced working copy was a real clone with the committed file.
    expect(workingCopyPathDuringRun).toBeDefined();
    expect(existsSync(join(workingCopyPathDuringRun!, "consumer.txt"))).toBe(true);

    const reply = await readReply(ctx);
    expect(reply.status).toBe("completed");
    if (reply.status === "completed") {
      expect(reply.result.codeScope).toBe("code+evidence");
    }
  });

  it("hostile tarball with a '..' traversal entry: terminal validation-error, no skill run, no files leaked", async () => {
    const ctx = await buildTriageStack();
    const hostile = makeTarGz([
      { path: "manifest.md", content: "# manifest" },
      { path: "../../evil-cron", content: "pwned" },
    ]);
    const evidenceBlobUri = await uploadEvidence(ctx, hostile, "acme/hostile.tar.gz");

    const result = await ctx.handler(
      sqsEventFor(ctx, `req-hostile-${Date.now()}`, {
        ticketKey: "SUP-44",
        customer: "acme",
        evidenceBlobUri,
      }),
    );

    // The reply channel is the load-bearing signal: handled + failed reply.
    expect(result.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(0);

    const reply = await readReply(ctx);
    expect(reply).toMatchObject({ status: "failed", error: { kind: "validation-error" } });
    if (reply.status === "failed") {
      expect(reply.error.message).toMatch(/invalid evidence archive: .*'\.\.' path segment/);
    }

    // Nothing extracted, nothing left behind under the pinned tmp base.
    expect(await readdir(evidenceTmpBase)).toEqual([]);
  });

  it("corrupt gzip body from S3: terminal validation-error, no skill run", async () => {
    const ctx = await buildTriageStack();
    const corrupt = new Uint8Array([0x1f, 0x8b, ...Buffer.from("not really gzip".repeat(16))]);
    const evidenceBlobUri = await uploadEvidence(ctx, corrupt, "acme/corrupt.tar.gz");

    const result = await ctx.handler(
      sqsEventFor(ctx, `req-corrupt-${Date.now()}`, {
        ticketKey: "SUP-45",
        customer: "acme",
        evidenceBlobUri,
      }),
    );

    expect(result.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(0);

    const reply = await readReply(ctx);
    expect(reply).toMatchObject({ status: "failed", error: { kind: "validation-error" } });
    if (reply.status === "failed") {
      expect(reply.error.message).toContain("archive could not be read");
    }
    expect(await readdir(evidenceTmpBase)).toEqual([]);
  });

  it("schema-invalid request: terminal validation-error reply, no S3 fetch, no skill run", async () => {
    const ctx = await buildTriageStack();

    const result = await ctx.handler(
      sqsEventFor(ctx, `req-invalid-${Date.now()}`, {
        customer: "acme", // ticketKey + evidenceBlobUri missing
      }),
    );

    expect(result.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(0);

    const reply = await readReply(ctx);
    expect(reply).toMatchObject({ status: "failed", error: { kind: "validation-error" } });
    if (reply.status === "failed") {
      expect(reply.error.message).toContain("ticketKey must be a non-empty string");
    }
  });

  it("rejects an envelope with a bad signature: batchItemFailure, no skill run, no reply", async () => {
    const ctx = await buildTriageStack();
    const evidenceBlobUri = await uploadEvidence(ctx, EVIDENCE_ARCHIVE);

    const result = await ctx.handler(
      sqsEventFor(
        ctx,
        `req-bad-sig-${Date.now()}`,
        { ticketKey: "SUP-46", customer: "acme", evidenceBlobUri },
        { secret: "WRONG-SECRET" },
      ),
    );

    expect(result.results[0]?.status).toBe("envelope-rejected");
    expect(result.batchItemFailures).toHaveLength(1);
    expect(ctx.fakeRunner.invocations).toHaveLength(0);

    const replies = await stack.readMessages(ctx.replyQueueUrl, {
      maxMessages: 1,
      timeoutMs: 2_000,
    });
    expect(replies).toHaveLength(0);
  });
});

// ----------------------------- helpers -----------------------------

function makeSignedEnvelope(args: {
  consumer: string;
  kind: string;
  endUser: string;
  requestId: string;
  payload: unknown;
  secret: string;
  conversationKey?: string;
  replyTo?: string;
}): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  const message =
    timestamp +
    "\n" +
    args.consumer +
    "\n" +
    args.endUser +
    "\n" +
    (args.conversationKey ?? "") +
    "\n" +
    canonicalize(args.payload);
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
  // LocalStack SQS URLs look like http://localhost:4566/000000000000/<name>.
  const url = new URL(queueUrl);
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  if (parts.length !== 2) {
    throw new Error(`unexpected LocalStack SQS URL shape: ${queueUrl}`);
  }
  const [account, name] = parts;
  return `arn:aws:sqs:us-east-1:${account}:${name}`;
}
