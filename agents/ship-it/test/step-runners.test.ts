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

// The implemented-but-dark steps stay `released: false` in production; these
// tests flip them on so the runners can be exercised end-to-end through the
// handler. The production default is pinned separately in steps.test.ts.
vi.mock("../src/steps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/steps.js")>();
  const flipped = ["groom-it", "spec-it", "review-it"];
  const steps = Object.fromEntries(
    Object.entries(actual.SHIP_IT_STEPS).map(([name, step]) => [
      name,
      flipped.includes(name) ? { ...step, released: true } : step,
    ]),
  );
  return { ...actual, SHIP_IT_STEPS: steps };
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

function enabledProject(statusSkillMap: Record<string, string>): Project {
  return {
    id: "acme/widgets",
    source: { url: "https://github.com/acme/widgets.git", branch: "main" },
    extensions: { "ship-it": { enabled: true, statusSkillMap } },
  };
}

async function buildHarness(args: {
  readonly project: Project;
  readonly outputs: Readonly<Record<string, unknown>>;
}): Promise<{
  runtime: Runtime;
  runner: FakeCodingAgentRunner;
  published: LocalSelfPublishEntry[];
}> {
  const descriptor = await loadDescriptorFromFile(join(PKG_ROOT, "agent.yaml"));
  const runner = new FakeCodingAgentRunner("claude-code");
  for (const [entrypoint, output] of Object.entries(args.outputs)) {
    runner.register(entrypoint, () => ({
      responseText: "```json\n" + JSON.stringify(output) + "\n```",
    }));
  }
  const published: LocalSelfPublishEntry[] = [];
  const runtime = await buildRuntime({
    descriptor,
    catalog: new InMemoryCatalog([args.project]),
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
      receivedAt: "2026-06-10T00:00:01.000Z",
      sourceTrigger: "consumer",
      requestId: "msg-1",
    },
  };
}

function baseRequest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ticketKey: "ABC-123",
    projectId: "acme/widgets",
    labels: ["ship-it"],
    ticketSummary: "Add a widget counter",
    ticketDescription: "Show the number of widgets on the dashboard.",
    ...overrides,
  };
}

describe("ship-it dark-step runners (released via test override)", () => {
  it("groom-it: ticket-only input, no working copies, no fan-out", async () => {
    const { runtime, runner, published } = await buildHarness({
      project: enabledProject({ "To Groom": "groom-it" }),
      outputs: {
        "groom-it": {
          outcome: "needs-work",
          findings: [
            {
              aspect: "acceptance-criteria",
              issue: "no testable criteria",
              suggestion: "add a given/when/then list",
            },
          ],
          notes: "comment posted",
        },
      },
    });
    await handleShipItMessage(
      initMessage(baseRequest({ ticketStatus: "To Groom" })),
      runtime,
    );
    expect(runner.invocations).toHaveLength(1);
    const invocation = runner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("groom-it");
    expect(invocation.workingCopies).toEqual([]);
    expect(invocation.renderedArguments).toContain("ticketKey: ABC-123");
    expect(invocation.renderedArguments).toContain("ship-it");
    expect(published).toHaveLength(0);
  });

  it("spec-it: code-grounded — syncs the project working copy", async () => {
    const { runtime, runner, published } = await buildHarness({
      project: enabledProject({ Speccing: "spec-it" }),
      outputs: {
        "spec-it": {
          outcome: "specced",
          specDraft: "## Approach\n…",
          openQuestions: ["which plan tiers does this apply to?"],
          suggestReady: false,
          notes: "comment posted",
        },
      },
    });
    await handleShipItMessage(
      initMessage(baseRequest({ ticketStatus: "Speccing" })),
      runtime,
    );
    expect(runner.invocations).toHaveLength(1);
    const invocation = runner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("spec-it");
    expect(invocation.workingCopies).toHaveLength(1);
    expect(invocation.renderedArguments).toContain("id: acme/widgets");
    expect(published).toHaveLength(0);
  });

  it("review-it: requires prNumber, passes repo context, never fans out", async () => {
    const { runtime, runner, published } = await buildHarness({
      project: enabledProject({ "In Review": "review-it" }),
      outputs: {
        "review-it": {
          outcome: "reviewed",
          verificationMode: "cross-model-consensus",
          findings: [],
          summary: "looks good — both models agreed",
          postedReview: true,
        },
      },
    });
    await handleShipItMessage(
      initMessage(baseRequest({ ticketStatus: "In Review", prNumber: 41 })),
      runtime,
    );
    expect(runner.invocations).toHaveLength(1);
    const invocation = runner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("review-it");
    expect(invocation.workingCopies).toHaveLength(1);
    expect(invocation.renderedArguments).toContain("prNumber: 41");
    expect(invocation.renderedArguments).toContain("projectId: acme/widgets");
    expect(published).toHaveLength(0);
  });

  it("review-it: a PR-less event is an advisory skip", async () => {
    const { runtime, runner } = await buildHarness({
      project: enabledProject({ "In Review": "review-it" }),
      outputs: {},
    });
    await handleShipItMessage(
      initMessage(baseRequest({ ticketStatus: "In Review" })),
      runtime,
    );
    expect(runner.invocations).toHaveLength(0);
  });
});
