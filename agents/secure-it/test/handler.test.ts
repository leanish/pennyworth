import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildRuntime,
  ConsoleLogger,
  defaultRuntimeSkillsDir,
  loadDescriptorFromFile,
  type Runtime,
  type RuntimeMessage,
  type SourceTrigger,
  type Stage,
} from "@leanish/runtime";
import {
  createLocalSelfPublisher,
  FakeCodingAgentRunner,
  InMemoryCatalog,
  InMemoryWorkspace,
  type LocalSelfPublishEntry,
  type Project,
} from "@leanish/runtime/testing";

import { handleSecureItMessage } from "../src/handler.js";
import type { SecureItPayload } from "../src/payload.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIPTOR_PATH = join(HERE, "..", "agent.yaml");
const AGENT_SKILLS_DIR = join(HERE, "..", "skills");

const QUIET_LOGGER = new ConsoleLogger({ minLevel: "error" });

const OPTED_IN: Project = {
  id: "leanish/widget",
  source: { url: "https://github.com/leanish/widget.git", branch: "main" },
  extensions: { "secure-it": { enabled: true } },
};

const OPTED_OUT: Project = {
  id: "leanish/opted-out",
  source: { url: "https://github.com/leanish/opted-out.git", branch: "main" },
  extensions: { "secure-it": { enabled: false } },
};

const NOT_CONFIGURED: Project = {
  id: "leanish/not-configured",
  source: { url: "https://github.com/leanish/not-configured.git", branch: "main" },
  extensions: {},
};

/**
 * Hermetic scaffold built from the REAL descriptor + REAL skill files:
 * `runSkill` loads the actual SKILL.md frontmatter, validates handler
 * input against the real inputSchema, and validates the fake runner's
 * canned response against the real outputSchema. No `skipCompatCheck`
 * — the startup compat gate runs against the shipped skills too.
 */
async function buildScaffold(projects: ReadonlyArray<Project>): Promise<{
  runtime: Runtime;
  runner: FakeCodingAgentRunner;
  queue: LocalSelfPublishEntry[];
}> {
  const descriptor = await loadDescriptorFromFile(DESCRIPTOR_PATH, { phase: "phase-2" });
  const runner = new FakeCodingAgentRunner("claude-code");
  const queue: LocalSelfPublishEntry[] = [];
  const runtime = await buildRuntime({
    descriptor,
    catalog: new InMemoryCatalog(projects),
    workspace: new InMemoryWorkspace(),
    runners: new Map([["claude-code", runner]]),
    clients: {},
    logger: QUIET_LOGGER,
    skillsDirs: [AGENT_SKILLS_DIR, defaultRuntimeSkillsDir()],
    selfPublisher: createLocalSelfPublisher(queue),
  });
  return { runtime, runner, queue };
}

function message(
  stage: Stage,
  payload: SecureItPayload,
  sourceTrigger: SourceTrigger,
): RuntimeMessage<SecureItPayload> {
  return {
    stage,
    payload,
    metadata: {
      receivedAt: "2026-06-10T12:00:00.000Z",
      sourceTrigger,
      requestId: "msg-1",
    },
  };
}

/** Wrap a value in the canonical fenced-json terminal block. */
function fencedJson(value: unknown): { responseText: string } {
  return { responseText: ["```json", JSON.stringify(value), "```"].join("\n") };
}

const REVISIT_PAYLOAD = {
  repo: "leanish/widget",
  branch: "secure-it/GHSA-aaaa",
  alertRef: "GHSA-aaaa",
} as const;

describe("secure-it init stage", () => {
  it("publishes one breakdown message per explicitly opted-in project (strict true only)", async () => {
    const { runtime, runner, queue } = await buildScaffold([OPTED_IN, OPTED_OUT, NOT_CONFIGURED]);
    await handleSecureItMessage(message("init", {}, "scheduler"), runtime);
    // enabled:false AND absent extensions are both skipped — only the
    // strict `enabled === true` project fans out.
    expect(queue).toHaveLength(1);
    expect(queue[0]?.body.stage).toBe("breakdown");
    expect(queue[0]?.body.payload).toEqual({ projectId: OPTED_IN.id });
    expect(queue[0]?.afterSeconds).toBeUndefined(); // immediate publish, not delayed
    expect(runner.invocations).toHaveLength(0); // init runs no skill
  });

  it("publishes nothing when no project is opted in", async () => {
    const { runtime, queue } = await buildScaffold([OPTED_OUT, NOT_CONFIGURED]);
    await handleSecureItMessage(message("init", {}, "scheduler"), runtime);
    expect(queue).toHaveLength(0);
  });
});

describe("secure-it breakdown stage", () => {
  it("syncs the project, runs the secure-it skill, and schedules one delayed revisit per PR", async () => {
    const { runtime, runner, queue } = await buildScaffold([OPTED_IN]);
    runner.register("secure-it", () =>
      fencedJson({
        summary: "Opened one PR, updated one, one alert already fixed.",
        alerts: [
          { alertRef: "GHSA-aaaa", outcome: "pr-opened" },
          { alertRef: "GHSA-bbbb", outcome: "pr-updated" },
          { alertRef: "GHSA-cccc", outcome: "already-fixed" },
        ],
        pullRequests: [
          {
            alertRef: "GHSA-aaaa",
            url: "https://github.com/leanish/widget/pull/1",
            branch: "secure-it/GHSA-aaaa",
            number: 1,
            title: "fix GHSA-aaaa",
          },
          {
            alertRef: "GHSA-bbbb",
            url: "https://github.com/leanish/widget/pull/2",
            branch: "secure-it/GHSA-bbbb",
            number: 2,
            title: "fix GHSA-bbbb",
          },
        ],
      }),
    );

    await handleSecureItMessage(
      message("breakdown", { projectId: OPTED_IN.id }, "self"),
      runtime,
    );

    // The skill ran once against the synced working copy with the
    // contract input shape (validated against the real inputSchema;
    // rendered YAML carries the project id + source url).
    expect(runner.invocations).toHaveLength(1);
    const invocation = runner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("secure-it");
    expect(invocation.workingCopies).toHaveLength(1);
    expect(invocation.workingCopies[0]?.projectId).toBe(OPTED_IN.id);
    expect(invocation.renderedArguments).toContain("id: leanish/widget");
    expect(invocation.renderedArguments).toContain(
      "url: https://github.com/leanish/widget.git",
    );

    // One delayed revisit per pullRequests[] entry, 1h out, count 0.
    expect(queue).toHaveLength(2);
    for (const entry of queue) {
      expect(entry.body.stage).toBe("revisit");
      expect(entry.afterSeconds).toBe(3600);
    }
    expect(queue.map((e) => e.body.payload)).toEqual([
      { repo: OPTED_IN.id, branch: "secure-it/GHSA-aaaa", alertRef: "GHSA-aaaa", revisitCount: 0 },
      { repo: OPTED_IN.id, branch: "secure-it/GHSA-bbbb", alertRef: "GHSA-bbbb", revisitCount: 0 },
    ]);
  });

  it("schedules no revisit when the skill opened no PRs", async () => {
    const { runtime, runner, queue } = await buildScaffold([OPTED_IN]);
    runner.register("secure-it", () =>
      fencedJson({ summary: "No open alerts.", alerts: [], pullRequests: [] }),
    );
    await handleSecureItMessage(
      message("breakdown", { projectId: OPTED_IN.id }, "self"),
      runtime,
    );
    expect(runner.invocations).toHaveLength(1);
    expect(queue).toHaveLength(0);
  });

  it("skips idempotently when the project is missing from the catalog", async () => {
    const { runtime, runner, queue } = await buildScaffold([OPTED_IN]);
    await handleSecureItMessage(
      message("breakdown", { projectId: "leanish/vanished" }, "self"),
      runtime,
    );
    expect(runner.invocations).toHaveLength(0);
    expect(queue).toHaveLength(0);
  });

  it("skips idempotently when the project is no longer strict-true opted in", async () => {
    // OPTED_OUT (enabled:false) is filtered out of the consumer view;
    // NOT_CONFIGURED is in the view but fails the strict opt-in check.
    // Both must skip without running the skill.
    const { runtime, runner, queue } = await buildScaffold([OPTED_OUT, NOT_CONFIGURED]);
    await handleSecureItMessage(
      message("breakdown", { projectId: OPTED_OUT.id }, "self"),
      runtime,
    );
    await handleSecureItMessage(
      message("breakdown", { projectId: NOT_CONFIGURED.id }, "self"),
      runtime,
    );
    expect(runner.invocations).toHaveLength(0);
    expect(queue).toHaveLength(0);
  });

  it("fails loudly on a malformed breakdown payload", async () => {
    const { runtime } = await buildScaffold([OPTED_IN]);
    await expect(
      handleSecureItMessage(message("breakdown", {} as never, "self"), runtime),
    ).rejects.toThrow(/projectId/);
  });
});

describe("secure-it revisit stage", () => {
  it("runs the revisit skill with no working copies and reschedules with a bumped count when under the cap", async () => {
    const { runtime, runner, queue } = await buildScaffold([OPTED_IN]);
    runner.register("secure-it-revisit", () =>
      fencedJson({
        outcome: "deferred",
        ciConclusion: "pending",
        scheduleRevisit: { afterSeconds: 1800 },
      }),
    );

    await handleSecureItMessage(
      message("revisit", { ...REVISIT_PAYLOAD, revisitCount: 1 }, "self"),
      runtime,
    );

    expect(runner.invocations).toHaveLength(1);
    const invocation = runner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("secure-it-revisit");
    expect(invocation.workingCopies).toEqual([]);
    expect(invocation.renderedArguments).toContain("repo: leanish/widget");
    expect(invocation.renderedArguments).toContain("branch: secure-it/GHSA-aaaa");
    expect(invocation.renderedArguments).toContain("revisitCount: 1");

    expect(queue).toHaveLength(1);
    expect(queue[0]?.body.stage).toBe("revisit");
    expect(queue[0]?.afterSeconds).toBe(1800); // skill-chosen delay
    expect(queue[0]?.body.payload).toEqual({ ...REVISIT_PAYLOAD, revisitCount: 2 });
  });

  it("stops at the cap — no publish when revisitCount is already 2, even if the skill asks", async () => {
    const { runtime, runner, queue } = await buildScaffold([OPTED_IN]);
    runner.register("secure-it-revisit", () =>
      fencedJson({
        outcome: "deferred",
        ciConclusion: "pending",
        scheduleRevisit: { afterSeconds: 1800 },
      }),
    );
    await handleSecureItMessage(
      message("revisit", { ...REVISIT_PAYLOAD, revisitCount: 2 }, "self"),
      runtime,
    );
    expect(runner.invocations).toHaveLength(1); // the skill still ran (final check)
    expect(queue).toHaveLength(0); // but nothing was rescheduled
  });

  it("does not reschedule when the skill returns no scheduleRevisit", async () => {
    const { runtime, runner, queue } = await buildScaffold([OPTED_IN]);
    runner.register("secure-it-revisit", () =>
      fencedJson({ outcome: "flipped", ciConclusion: "success" }),
    );
    await handleSecureItMessage(
      message("revisit", { ...REVISIT_PAYLOAD, revisitCount: 0 }, "self"),
      runtime,
    );
    expect(runner.invocations).toHaveLength(1);
    expect(queue).toHaveLength(0);
  });

  it("fails loudly on a malformed revisit payload", async () => {
    const { runtime } = await buildScaffold([OPTED_IN]);
    await expect(
      handleSecureItMessage(
        message("revisit", { repo: "leanish/widget" } as never, "self"),
        runtime,
      ),
    ).rejects.toThrow(/revisit payload/);
  });
});
