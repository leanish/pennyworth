import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  buildRuntime,
  defaultRuntimeSkillsDir,
  loadDescriptorFromFile,
  wireClients,
  type Logger,
  type Project,
  type Runtime,
  type RuntimeMessage,
} from "@leanish/runtime";
import {
  createLocalSelfPublisher,
  FakeCodingAgentRunner,
  InMemoryCatalog,
  InMemoryWorkspace,
  type LocalSelfPublishEntry,
} from "@leanish/runtime/testing";

import { handleShipItMessage } from "../src/handler.js";
import type { ShipItPayload } from "../src/payload.js";
import { ShipItValidationError } from "../src/request-schema.js";

// code-it is currently merged dark (the live rollout starts from groom-it);
// these tests exercise the code-it flow itself, so flip it released here.
// The production default is pinned in steps.test.ts.
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

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  with() {
    return this;
  },
};

const ENABLED_PROJECT: Project = {
  id: "acme/widgets",
  source: { url: "https://github.com/acme/widgets.git", branch: "main" },
  extensions: { "ship-it": { enabled: true } },
};

const PR_OPENED_OUTPUT = {
  outcome: "pr-opened",
  pullRequest: {
    url: "https://github.com/acme/widgets/pull/42",
    number: 42,
    branch: "ship-it/ABC-123",
  },
  notes: "implemented and tested",
};

/**
 * Real `buildRuntime` against the package's own skills tree, so handler
 * tests exercise the actual skill schemas (input + output validation)
 * alongside the handler logic.
 */
async function buildHarness(
  args: {
    readonly projects?: ReadonlyArray<Project>;
    readonly codeItOutput?: unknown;
    readonly revisitOutput?: unknown;
  } = {},
): Promise<{
  runtime: Runtime;
  runner: FakeCodingAgentRunner;
  published: LocalSelfPublishEntry[];
}> {
  const descriptor = await loadDescriptorFromFile(join(PKG_ROOT, "agent.yaml"));
  const runner = new FakeCodingAgentRunner("claude-code");
  if (args.codeItOutput !== undefined) {
    runner.register("code-it", () => fenced(args.codeItOutput));
  }
  if (args.revisitOutput !== undefined) {
    runner.register("code-it-revisit", () => fenced(args.revisitOutput));
  }
  const published: LocalSelfPublishEntry[] = [];
  const runtime = await buildRuntime({
    descriptor,
    catalog: new InMemoryCatalog(args.projects ?? [ENABLED_PROJECT]),
    workspace: new InMemoryWorkspace(),
    runners: new Map([["claude-code", runner]]),
    clients: wireClients({
      mode: "local",
      needs: descriptor.needs,
      env: {},
      region: "us-east-1",
      logger: noopLogger,
    }),
    logger: noopLogger,
    selfPublisher: createLocalSelfPublisher(published),
    skillsDirs: [join(PKG_ROOT, "skills"), defaultRuntimeSkillsDir()],
  });
  return { runtime, runner, published };
}

function fenced(value: unknown): { responseText: string } {
  return { responseText: "```json\n" + JSON.stringify(value) + "\n```" };
}

function validRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticketKey: "ABC-123",
    projectId: ENABLED_PROJECT.id,
    ticketStatus: "Ready for Implementation",
    labels: ["ship-it", "backend"],
    ticketSummary: "Add a widget counter",
    ticketDescription: "Show the number of widgets on the dashboard.",
    acceptanceCriteria: ["the dashboard shows the widget count"],
    ...overrides,
  };
}

function initMessage(request: Record<string, unknown>): RuntimeMessage<ShipItPayload> {
  return {
    stage: "init",
    payload: {
      envelope: {
        kind: "ship-it-event",
        requestId: "evt-1",
        consumer: "webhook-normalizer",
        endUser: "jira:U100",
        timestamp: "2026-06-10T00:00:00.000Z",
      },
      request: request as never,
    } as never,
    metadata: {
      receivedAt: "2026-06-10T00:00:00.000Z",
      sourceTrigger: "consumer",
      requestId: "sqs-init-1",
    },
  };
}

function revisitMessage(payload: Record<string, unknown>): RuntimeMessage<ShipItPayload> {
  return {
    stage: "revisit",
    payload: payload as never,
    metadata: {
      receivedAt: "2026-06-10T01:00:00.000Z",
      sourceTrigger: "self",
      requestId: "sqs-revisit-1",
    },
  };
}

function validRevisitPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticketKey: "ABC-123",
    projectId: ENABLED_PROJECT.id,
    prNumber: 42,
    branch: "ship-it/ABC-123",
    revisitCount: 0,
    ...overrides,
  };
}

describe("ship-it init — gates", () => {
  it("skips when the project has no ship-it extension at all", async () => {
    const { runtime, runner, published } = await buildHarness({
      projects: [{ ...ENABLED_PROJECT, extensions: {} }],
    });
    await handleShipItMessage(initMessage(validRequest()), runtime);
    expect(runner.invocations).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("skips when extensions['ship-it'].enabled is false", async () => {
    const { runtime, runner, published } = await buildHarness({
      projects: [{ ...ENABLED_PROJECT, extensions: { "ship-it": { enabled: false } } }],
    });
    await handleShipItMessage(initMessage(validRequest()), runtime);
    expect(runner.invocations).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("skips when the extension exists but 'enabled' is missing (strict gate, no default-on)", async () => {
    const { runtime, runner, published } = await buildHarness({
      projects: [{ ...ENABLED_PROJECT, extensions: { "ship-it": {} } }],
    });
    await handleShipItMessage(initMessage(validRequest()), runtime);
    expect(runner.invocations).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("skips when the project is not in the catalog at all", async () => {
    const { runtime, runner, published } = await buildHarness({ projects: [] });
    await handleShipItMessage(initMessage(validRequest()), runtime);
    expect(runner.invocations).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("skips when the ticket does not carry the 'ship-it' label", async () => {
    const { runtime, runner, published } = await buildHarness({});
    await handleShipItMessage(
      initMessage(validRequest({ labels: ["backend"] })),
      runtime,
    );
    expect(runner.invocations).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("skips an unmapped ticket status (advisory skip, not an error)", async () => {
    const { runtime, runner, published } = await buildHarness({});
    await handleShipItMessage(
      initMessage(validRequest({ ticketStatus: "In Review" })),
      runtime,
    );
    expect(runner.invocations).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("throws ShipItValidationError on a malformed request (missing ticketKey)", async () => {
    const { runtime, runner } = await buildHarness({});
    const request = validRequest();
    delete request["ticketKey"];
    await expect(handleShipItMessage(initMessage(request), runtime)).rejects.toThrow(
      ShipItValidationError,
    );
    expect(runner.invocations).toHaveLength(0);
  });
});

describe("ship-it init — code-it", () => {
  it("happy path: runs code-it with the ticket + project input and schedules the first revisit", async () => {
    const { runtime, runner, published } = await buildHarness({
      codeItOutput: PR_OPENED_OUTPUT,
    });
    await handleShipItMessage(initMessage(validRequest()), runtime);

    expect(runner.invocations).toHaveLength(1);
    const invocation = runner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("code-it");
    // One working copy: the gated project, synced before the run.
    expect(invocation.workingCopies.map((wc) => wc.projectId)).toEqual([ENABLED_PROJECT.id]);
    // Input shape (validated against the skill's inputSchema by runSkill;
    // spot-check the rendered arguments carry the ticket + project fields).
    expect(invocation.renderedArguments).toContain("ticketKey: ABC-123");
    expect(invocation.renderedArguments).toContain("ticketSummary: Add a widget counter");
    expect(invocation.renderedArguments).toContain("id: acme/widgets");
    expect(invocation.renderedArguments).toContain("the dashboard shows the widget count");

    expect(published).toHaveLength(1);
    const entry = published[0]!;
    expect(entry.afterSeconds).toBe(3600);
    expect(entry.body.stage).toBe("revisit");
    expect(entry.body.payload).toEqual({
      ticketKey: "ABC-123",
      projectId: ENABLED_PROJECT.id,
      prNumber: 42,
      branch: "ship-it/ABC-123",
      revisitCount: 0,
    });
  });

  it("clarification-needed → no revisit scheduled", async () => {
    const { runtime, runner, published } = await buildHarness({
      codeItOutput: {
        outcome: "clarification-needed",
        notes: "1. Which dashboard? 2. Should archived widgets count?",
      },
    });
    await handleShipItMessage(initMessage(validRequest()), runtime);
    expect(runner.invocations).toHaveLength(1);
    expect(published).toHaveLength(0);
  });

  it("deferred → no revisit scheduled", async () => {
    const { runtime, published } = await buildHarness({
      codeItOutput: { outcome: "deferred", notes: "test suite cannot run in this environment" },
    });
    await handleShipItMessage(initMessage(validRequest()), runtime);
    expect(published).toHaveLength(0);
  });

  it("pr-opened WITHOUT pullRequest details → no revisit scheduled", async () => {
    const { runtime, published } = await buildHarness({
      codeItOutput: { outcome: "pr-opened", notes: "oops, lost the PR reference" },
    });
    await handleShipItMessage(initMessage(validRequest()), runtime);
    expect(published).toHaveLength(0);
  });

  it("skips statuses mapped to an unreleased step (merged dark, not yet flipped)", async () => {
    const project: Project = {
      ...ENABLED_PROJECT,
      extensions: {
        "ship-it": {
          enabled: true,
          statusSkillMap: { "In Review": "review-it" },
        },
      },
    };
    const { runtime, runner, published } = await buildHarness({ projects: [project] });
    await handleShipItMessage(
      initMessage(validRequest({ ticketStatus: "In Review" })),
      runtime,
    );
    // review-it exists in the step registry but is not released: advisory
    // skip — no skill run, no revisit, no failure.
    expect(runner.invocations).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("skips statuses mapped to a step the registry doesn't know", async () => {
    const project: Project = {
      ...ENABLED_PROJECT,
      extensions: {
        "ship-it": {
          enabled: true,
          statusSkillMap: { "Weird Status": "not-a-step" },
        },
      },
    };
    const { runtime, runner, published } = await buildHarness({ projects: [project] });
    await handleShipItMessage(
      initMessage(validRequest({ ticketStatus: "Weird Status" })),
      runtime,
    );
    expect(runner.invocations).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("honors a statusSkillMap override from extensions (replaces the default map)", async () => {
    const project: Project = {
      ...ENABLED_PROJECT,
      extensions: {
        "ship-it": {
          enabled: true,
          statusSkillMap: { "Implement Me": "code-it" },
        },
      },
    };
    const { runtime, runner, published } = await buildHarness({
      projects: [project],
      codeItOutput: PR_OPENED_OUTPUT,
    });

    // The overridden status triggers code-it…
    await handleShipItMessage(
      initMessage(validRequest({ ticketStatus: "Implement Me" })),
      runtime,
    );
    expect(runner.invocations).toHaveLength(1);
    expect(published).toHaveLength(1);

    // …and the default status is no longer mapped (override replaces, no merge).
    await handleShipItMessage(
      initMessage(validRequest({ ticketStatus: "Ready for Implementation" })),
      runtime,
    );
    expect(runner.invocations).toHaveLength(1);
    expect(published).toHaveLength(1);
  });
});

describe("ship-it revisit", () => {
  it("runs code-it-revisit with the revisit input and no working copies", async () => {
    const { runtime, runner, published } = await buildHarness({
      revisitOutput: { outcome: "flipped", ciConclusion: "success" },
    });
    await handleShipItMessage(revisitMessage(validRevisitPayload({ revisitCount: 1 })), runtime);

    expect(runner.invocations).toHaveLength(1);
    const invocation = runner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("code-it-revisit");
    expect(invocation.workingCopies).toEqual([]);
    expect(invocation.renderedArguments).toContain("ticketKey: ABC-123");
    // The repo context for the skill's `gh --repo` calls — a revisit mounts
    // no working copy, so this is its only repository identity.
    expect(invocation.renderedArguments).toContain("projectId: acme/widgets");
    expect(invocation.renderedArguments).toContain("prNumber: 42");
    expect(invocation.renderedArguments).toContain("branch: ship-it/ABC-123");
    expect(invocation.renderedArguments).toContain("revisitCount: 1");

    // flipped without scheduleRevisit → settled, no reschedule.
    expect(published).toHaveLength(0);
  });

  it("reschedules under the cap, passing the skill's afterSeconds through and bumping revisitCount", async () => {
    const { runtime, published } = await buildHarness({
      revisitOutput: {
        outcome: "deferred",
        ciConclusion: "pending",
        scheduleRevisit: { afterSeconds: 1800 },
      },
    });
    await handleShipItMessage(revisitMessage(validRevisitPayload({ revisitCount: 2 })), runtime);

    expect(published).toHaveLength(1);
    const entry = published[0]!;
    expect(entry.afterSeconds).toBe(1800);
    expect(entry.body.stage).toBe("revisit");
    expect(entry.body.payload).toEqual({
      ticketKey: "ABC-123",
      projectId: ENABLED_PROJECT.id,
      prNumber: 42,
      branch: "ship-it/ABC-123",
      revisitCount: 3,
    });
  });

  it("stops at the cap: revisitCount 3 never reschedules even when the skill asks", async () => {
    const { runtime, runner, published } = await buildHarness({
      revisitOutput: {
        outcome: "deferred",
        ciConclusion: "pending",
        scheduleRevisit: { afterSeconds: 1800 },
      },
    });
    await handleShipItMessage(revisitMessage(validRevisitPayload({ revisitCount: 3 })), runtime);
    expect(runner.invocations).toHaveLength(1); // the skill still ran once…
    expect(published).toHaveLength(0); // …but the loop is over.
  });

  it("throws ShipItValidationError on a malformed revisit payload", async () => {
    const { runtime, runner } = await buildHarness({});
    await expect(
      handleShipItMessage(revisitMessage(validRevisitPayload({ prNumber: "42" })), runtime),
    ).rejects.toThrow(ShipItValidationError);
    expect(runner.invocations).toHaveLength(0);
  });
});
