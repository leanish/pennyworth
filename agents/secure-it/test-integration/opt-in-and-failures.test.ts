import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Project } from "@leanish/catalog-it";
import { LocalStackHarness } from "@leanish/runtime/testing";

import {
  coldStartHandler,
  fencedJson,
  listSchedules,
  provisionSecureItStack,
  republishCatalog,
  schedulerTickRecord,
  SECURE_IT_ENV_VARS,
  seedLocalGitRepo,
} from "./helpers.js";

/**
 * Opt-in enforcement and failure paths over the REAL seams (S3 catalog,
 * SQS self-publish, DynamoDB idempotency):
 *
 *   - strict opt-in at init (literal `enabled === true` only) against a
 *     real published catalog bundle;
 *   - opt-in revoked / project vanished between init and breakdown —
 *     honored on the cold start that processes the breakdown, skipped
 *     idempotently (handled, no skill run, no schedules);
 *   - a skill output that violates the output schema fails the record
 *     LOUDLY: batch-item failure (SQS keeps it → DLQ via maxReceiveCount)
 *     and the real DDB claim is expired so the redelivery retries.
 */
describe("secure-it opt-in enforcement and failure paths against LocalStack", () => {
  const stack = new LocalStackHarness();
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await stack.start();
    for (const name of SECURE_IT_ENV_VARS) originalEnv[name] = process.env[name];
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await stack.stop();
  });

  beforeEach(() => {
    for (const name of SECURE_IT_ENV_VARS) delete process.env[name];
  });

  function projects(repoUrl: string): {
    optedIn: Project;
    optedOut: Project;
    notConfigured: Project;
  } {
    return {
      optedIn: {
        id: "leanish/sqs-codec",
        source: { url: repoUrl, branch: "main" },
        extensions: { "secure-it": { enabled: true } },
      },
      optedOut: {
        id: "leanish/lcli",
        source: { url: "https://github.com/leanish/lcli.git", branch: "main" },
        extensions: { "secure-it": { enabled: false } },
      },
      notConfigured: {
        id: "leanish/reviewit",
        source: { url: "https://github.com/leanish/reviewit.git", branch: "main" },
        extensions: {},
      },
    };
  }

  it("init fans out ONLY the literal enabled:true project from the real S3 catalog", async () => {
    const repoUrl = await seedLocalGitRepo();
    const { optedIn, optedOut, notConfigured } = projects(repoUrl);
    const ctx = await provisionSecureItStack(stack, [optedIn, optedOut, notConfigured]);

    const tick = await ctx.handler({ Records: [schedulerTickRecord(`tick-optin-${stack.id}`)] });
    expect(tick.results[0]?.status).toBe("handled");

    // enabled:false AND extension-absent are both excluded — catalog
    // membership (the default-on consumer view) is not enough.
    const fanout = await stack.readMessages(ctx.queueUrl, { maxMessages: 5, timeoutMs: 10_000 });
    expect(fanout).toHaveLength(1);
    expect((JSON.parse(fanout[0]!.body) as { payload: { projectId: string } }).payload.projectId).toBe(
      optedIn.id,
    );
  });

  it("opt-in revoked between init and breakdown → idempotent skip, no skill run, no schedules", async () => {
    const repoUrl = await seedLocalGitRepo();
    const { optedIn } = projects(repoUrl);
    const ctx = await provisionSecureItStack(stack, [optedIn]);

    await ctx.handler({ Records: [schedulerTickRecord(`tick-revoke-${stack.id}`)] });
    const fanout = await stack.readMessages(ctx.queueUrl, { maxMessages: 1, timeoutMs: 10_000 });
    expect(fanout).toHaveLength(1);

    // Curator revokes the opt-in while the breakdown message is in flight.
    await republishCatalog(stack, ctx.bucket, [
      { ...optedIn, extensions: { "secure-it": { enabled: false } } },
    ]);

    // The breakdown lands on a later cold start that reads the CURRENT catalog.
    const cold = await coldStartHandler();
    const result = await cold.handler({
      Records: [{ messageId: fanout[0]!.messageId, body: fanout[0]!.body }],
    });
    expect(result.results[0]?.status).toBe("handled"); // skip is NOT an error
    expect(result.batchItemFailures).toHaveLength(0);
    expect(cold.fakeRunner.invocations).toHaveLength(0); // write-capable skill never ran
    expect(await listSchedules(stack, ctx.scheduleGroup)).toHaveLength(0);
  });

  it("project vanished from the catalog between init and breakdown → idempotent skip", async () => {
    const repoUrl = await seedLocalGitRepo();
    const { optedIn, notConfigured } = projects(repoUrl);
    const ctx = await provisionSecureItStack(stack, [optedIn]);

    await ctx.handler({ Records: [schedulerTickRecord(`tick-vanish-${stack.id}`)] });
    const fanout = await stack.readMessages(ctx.queueUrl, { maxMessages: 1, timeoutMs: 10_000 });
    expect(fanout).toHaveLength(1);

    // The project is dropped from the catalog entirely.
    await republishCatalog(stack, ctx.bucket, [notConfigured]);

    const cold = await coldStartHandler();
    const result = await cold.handler({
      Records: [{ messageId: fanout[0]!.messageId, body: fanout[0]!.body }],
    });
    expect(result.results[0]?.status).toBe("handled");
    expect(cold.fakeRunner.invocations).toHaveLength(0);
    expect(await listSchedules(stack, ctx.scheduleGroup)).toHaveLength(0);
  });

  it("schema-violating skill output fails the record loudly and the DDB claim allows a retry", async () => {
    const repoUrl = await seedLocalGitRepo();
    const { optedIn } = projects(repoUrl);
    const ctx = await provisionSecureItStack(stack, [optedIn]);
    // Missing the required `pullRequests` — fails the real outputSchema.
    ctx.fakeRunner.register("secure-it", () => fencedJson({ summary: "broken", alerts: [] }));

    await ctx.handler({ Records: [schedulerTickRecord(`tick-bad-${stack.id}`)] });
    const fanout = await stack.readMessages(ctx.queueUrl, { maxMessages: 1, timeoutMs: 10_000 });
    expect(fanout).toHaveLength(1);
    const record = { messageId: fanout[0]!.messageId, body: fanout[0]!.body };

    const first = await ctx.handler({ Records: [record] });
    expect(first.results[0]?.status).toBe("handler-failed"); // loud, not a silent skip
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: record.messageId }]); // SQS keeps it → DLQ path
    expect(ctx.fakeRunner.invocations).toHaveLength(1);
    expect(await listSchedules(stack, ctx.scheduleGroup)).toHaveLength(0); // nothing scheduled off garbage

    // The real DynamoDB claim was expired on failure: the redelivery
    // re-claims and re-runs (it would succeed once the skill behaves).
    const second = await ctx.handler({ Records: [record] });
    expect(second.results[0]?.status).toBe("handler-failed");
    expect(ctx.fakeRunner.invocations).toHaveLength(2);
  });
});
