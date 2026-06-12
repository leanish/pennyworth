import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Project } from "@leanish/catalog-it";
import { LocalStackHarness } from "@leanish/runtime/testing";

import {
  fencedJson,
  fireTimeMillis,
  listSchedules,
  provisionSecureItStack,
  schedulerTickRecord,
  SECURE_IT_ENV_VARS,
  seedLocalGitRepo,
  simulateScheduleFire,
} from "./helpers.js";

/**
 * Full three-stage secure-it lifecycle against real LocalStack resources:
 *
 *   scheduler tick (infra's exact wire shape) → init fan-out lands real
 *   SQS messages on the agent's own input queue → breakdown claims via
 *   real DynamoDB, syncs a REAL git clone, runs the (fake) `secure-it`
 *   skill, creates REAL one-shot EventBridge Scheduler revisits → the
 *   simulated fire (LocalStack Community's Scheduler is CRUD-only — see
 *   the runtime's self-publish integration test) drives `revisit` rounds
 *   until the handler-enforced cap stops the loop.
 *
 * The coding agent is a `FakeCodingAgentRunner` (no live CLI, no GitHub
 * writes); everything else — S3 catalog read, SQS, DynamoDB idempotency,
 * Scheduler CRUD, git clone — runs through the same code paths as
 * production. `stack.start()` throws if LocalStack is unreachable: the
 * gate fails loudly instead of silently skipping.
 */
describe("secure-it lifecycle end-to-end against LocalStack", () => {
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

  it("walks init → breakdown → revisit chain with the revisit cap terminating the loop", async () => {
    const repoUrl = await seedLocalGitRepo();
    const optedIn: Project = {
      id: "leanish/sqs-codec",
      source: { url: repoUrl, branch: "main" },
      extensions: { "secure-it": { enabled: true } },
    };
    const notOptedIn: Project = {
      id: "leanish/lcli",
      source: { url: "https://github.com/leanish/lcli.git", branch: "main" },
      extensions: {},
    };
    const ctx = await provisionSecureItStack(stack, [optedIn, notOptedIn]);

    // ---- stage 1: the scheduler tick (infra's exact wire shape) ----
    const tick = await ctx.handler({ Records: [schedulerTickRecord(`tick-${stack.id}`)] });
    expect(tick.batchItemFailures).toHaveLength(0);
    expect(tick.results[0]?.status).toBe("handled");

    // The fan-out landed on the REAL input queue: exactly one breakdown
    // message — strict opt-in filtered `leanish/lcli` out at init.
    const fanout = await stack.readMessages(ctx.queueUrl, { maxMessages: 5, timeoutMs: 10_000 });
    expect(fanout).toHaveLength(1);
    const breakdownBody = JSON.parse(fanout[0]!.body) as {
      stage: string;
      payload: Record<string, unknown>;
      metadata: { sourceTrigger: string };
    };
    expect(breakdownBody.stage).toBe("breakdown");
    expect(breakdownBody.payload).toEqual({ projectId: optedIn.id });
    expect(breakdownBody.metadata.sourceTrigger).toBe("self");
    expect(ctx.fakeRunner.invocations).toHaveLength(0); // init runs no skill

    // ---- stage 2: breakdown — realistic "opened 2 draft PRs" output ----
    ctx.fakeRunner.register("secure-it", () =>
      fencedJson({
        summary:
          "Batched dependency refresh opened as a draft PR; one CVE needed a dedicated floor PR.",
        alerts: [
          { alertRef: "CVE-2026-41111", outcome: "pr-opened" },
          { alertRef: "GHSA-aaaa-bbbb-cccc", outcome: "pr-opened" },
          { alertRef: "CVE-2025-30000", outcome: "already-fixed" },
        ],
        pullRequests: [
          {
            alertRef: "dependency-refresh",
            url: "https://github.com/leanish/sqs-codec/pull/41",
            branch: "secure-it/dependency-refresh",
            number: 41,
            title: "deps: dependency refresh + CVE floors",
          },
          {
            alertRef: "GHSA-aaaa-bbbb-cccc",
            url: "https://github.com/leanish/sqs-codec/pull/42",
            branch: "secure-it/GHSA-aaaa-bbbb-cccc",
            number: 42,
            title: "deps: floor for GHSA-aaaa-bbbb-cccc",
          },
        ],
      }),
    );

    const tBefore = Date.now();
    const breakdown = await ctx.handler({
      Records: [{ messageId: fanout[0]!.messageId, body: fanout[0]!.body }],
    });
    const tAfter = Date.now();
    expect(breakdown.batchItemFailures).toHaveLength(0);
    expect(breakdown.results[0]?.status).toBe("handled");

    // The skill ran against a REAL git clone of the catalog source.
    expect(ctx.fakeRunner.invocations).toHaveLength(1);
    const invocation = ctx.fakeRunner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("secure-it");
    expect(invocation.workingCopies).toHaveLength(1);
    const workingCopy = invocation.workingCopies[0]!;
    expect(workingCopy.projectId).toBe(optedIn.id);
    expect(existsSync(join(workingCopy.path, "build.gradle"))).toBe(true);

    // One REAL one-shot schedule per PR, ~1h out, revisitCount 0.
    const afterBreakdown = await listSchedules(stack, ctx.scheduleGroup);
    expect(afterBreakdown).toHaveLength(2);
    for (const schedule of afterBreakdown) {
      expect(schedule.body.stage).toBe("revisit");
      expect(schedule.body.metadata.sourceTrigger).toBe("self");
      expect(schedule.body.payload["repo"]).toBe(optedIn.id);
      expect(schedule.body.payload["revisitCount"]).toBe(0);
      const fireAt = fireTimeMillis(schedule.expression);
      expect(fireAt).toBeGreaterThanOrEqual(tBefore + 3600_000 - 2_000);
      expect(fireAt).toBeLessThanOrEqual(tAfter + 3600_000 + 2_000);
    }
    const branches = afterBreakdown.map((s) => s.body.payload["branch"]).sort();
    expect(branches).toEqual(["secure-it/GHSA-aaaa-bbbb-cccc", "secure-it/dependency-refresh"]);

    // ---- stage 3: revisit round 0 → deferred + reschedule (count 1) ----
    const batchedRevisit = afterBreakdown.find(
      (s) => s.body.payload["branch"] === "secure-it/dependency-refresh",
    )!;
    ctx.fakeRunner.register("secure-it-revisit", () =>
      fencedJson({
        outcome: "deferred",
        ciConclusion: "pending",
        scheduleRevisit: { afterSeconds: 1800 },
      }),
    );

    const fired0 = await simulateScheduleFire(stack, ctx.queueUrl, batchedRevisit);
    const revisit0 = await ctx.handler({ Records: [fired0] });
    expect(revisit0.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(2);
    const revisitInvocation = ctx.fakeRunner.invocations[1]!;
    expect(revisitInvocation.entrypoint.name).toBe("secure-it-revisit");
    expect(revisitInvocation.workingCopies).toEqual([]); // PR state lives on GitHub
    expect(revisitInvocation.renderedArguments).toContain("revisitCount: 0");

    const afterRound0 = await listSchedules(stack, ctx.scheduleGroup);
    expect(afterRound0).toHaveLength(3); // LocalStack never deletes fired schedules
    const round1 = afterRound0.find((s) => s.body.payload["revisitCount"] === 1)!;
    expect(round1.body.payload["branch"]).toBe("secure-it/dependency-refresh");
    expect(round1.body.payload["alertRef"]).toBe("dependency-refresh");
    const round1FireAt = fireTimeMillis(round1.expression);
    expect(round1FireAt - Date.now()).toBeGreaterThan(1800_000 - 30_000); // skill-chosen 30min delay
    expect(round1FireAt - Date.now()).toBeLessThanOrEqual(1800_000 + 2_000);

    // ---- revisit round 1 → deferred again → reschedule (count 2) ----
    const fired1 = await simulateScheduleFire(stack, ctx.queueUrl, round1);
    const revisit1 = await ctx.handler({ Records: [fired1] });
    expect(revisit1.results[0]?.status).toBe("handled");
    const afterRound1 = await listSchedules(stack, ctx.scheduleGroup);
    expect(afterRound1).toHaveLength(4);
    const round2 = afterRound1.find((s) => s.body.payload["revisitCount"] === 2)!;
    expect(round2.body.payload["branch"]).toBe("secure-it/dependency-refresh");

    // ---- revisit round 2 = the cap: skill still runs, NO reschedule ----
    const fired2 = await simulateScheduleFire(stack, ctx.queueUrl, round2);
    const revisit2 = await ctx.handler({ Records: [fired2] });
    expect(revisit2.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(4); // final check still ran
    const afterCap = await listSchedules(stack, ctx.scheduleGroup);
    expect(afterCap).toHaveLength(4); // unchanged — the loop terminated

    // ---- the second PR's chain ends immediately on a terminal outcome ----
    ctx.fakeRunner.register("secure-it-revisit", () =>
      fencedJson({ outcome: "flipped", ciConclusion: "success" }),
    );
    const cveRevisit = afterBreakdown.find(
      (s) => s.body.payload["branch"] === "secure-it/GHSA-aaaa-bbbb-cccc",
    )!;
    const firedCve = await simulateScheduleFire(stack, ctx.queueUrl, cveRevisit);
    const revisitCve = await ctx.handler({ Records: [firedCve] });
    expect(revisitCve.results[0]?.status).toBe("handled");
    expect(await listSchedules(stack, ctx.scheduleGroup)).toHaveLength(4); // no new schedule
  });

  it("dedupes a redelivered breakdown via the real DynamoDB claim — the skill runs once", async () => {
    const repoUrl = await seedLocalGitRepo();
    const project: Project = {
      id: "leanish/sqs-codec",
      source: { url: repoUrl, branch: "main" },
      extensions: { "secure-it": { enabled: true } },
    };
    const ctx = await provisionSecureItStack(stack, [project]);
    ctx.fakeRunner.register("secure-it", () =>
      fencedJson({ summary: "Repo fully current.", alerts: [], pullRequests: [] }),
    );

    await ctx.handler({ Records: [schedulerTickRecord(`tick-dup-${stack.id}`)] });
    const fanout = await stack.readMessages(ctx.queueUrl, { maxMessages: 1, timeoutMs: 10_000 });
    expect(fanout).toHaveLength(1);
    const record = { messageId: fanout[0]!.messageId, body: fanout[0]!.body };

    const first = await ctx.handler({ Records: [record] });
    expect(first.results[0]?.status).toBe("handled");
    expect(ctx.fakeRunner.invocations).toHaveLength(1);

    // SQS at-least-once redelivery of the same MessageId: the real DDB
    // conditional write reports prior completion; no second skill run.
    const second = await ctx.handler({ Records: [record] });
    expect(second.results[0]?.status).toBe("duplicate-completed");
    expect(second.batchItemFailures).toHaveLength(0);
    expect(ctx.fakeRunner.invocations).toHaveLength(1);
  });
});
