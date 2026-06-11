import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildRuntime,
  defaultRuntimeSkillsDir,
  loadDescriptorFromFile,
} from "@leanish/runtime";
import type {
  LogFields,
  Logger,
  Project,
  Runtime,
  RuntimeMessage,
} from "@leanish/runtime";
import {
  createLocalSelfPublisher,
  FakeCodingAgentRunner,
  InMemoryCatalog,
  InMemoryWorkspace,
  type LocalSelfPublishEntry,
} from "@leanish/runtime/testing";

import { handleDocumentItMessage } from "../src/handler.js";
import type { DocumentItPayload } from "../src/payload.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIPTOR_PATH = join(HERE, "..", "agent.yaml");
const AGENT_SKILLS_DIR = join(HERE, "..", "skills");

const ENABLED_WITH_DOC_SET: Project = {
  id: "acme/widgets",
  source: { url: "https://github.com/acme/widgets.git", branch: "main" },
  extensions: {
    "document-it": {
      enabled: true,
      docSet: { space: "WID", pageIds: ["101", "102"], labels: ["widgets-docs"] },
    },
  },
};

const ENABLED_NO_DOC_SET: Project = {
  id: "acme/gadgets",
  source: { url: "https://github.com/acme/gadgets.git", branch: "develop" },
  extensions: { "document-it": { enabled: true } },
};

const EXPLICITLY_DISABLED: Project = {
  id: "acme/legacy",
  source: { url: "https://github.com/acme/legacy.git", branch: "main" },
  extensions: { "document-it": { enabled: false } },
};

/** In the catalog view (default-on) but NOT explicitly opted in — out of scope. */
const NO_EXTENSION: Project = {
  id: "acme/quiet",
  source: { url: "https://github.com/acme/quiet.git", branch: "main" },
  extensions: {},
};

const CANNED_OUTPUT = {
  summary: "Audited README.md and docs/ against the code; 2 in-repo claims drifted.",
  inRepoDrift: [
    {
      type: "stale",
      location: "README.md#requirements",
      claim: "Requires Node 18.",
      correction: "Requires Node 24.",
      confidence: 0.95,
    },
    {
      type: "wrong",
      location: "docs/usage.md#retries",
      claim: "Retries forever.",
      correction: "Retries 5 times with adaptive backoff.",
      confidence: 0.8,
    },
  ],
  publishedDrift: [
    {
      type: "missing",
      location: "WID/101#authentication",
      claim: "The page does not mention token rotation.",
      suggestion: "Add a 'Token rotation' subsection describing the 90-day rotation.",
      confidence: 0.7,
    },
  ],
  pullRequest: {
    url: "https://github.com/acme/widgets/pull/7",
    branch: "document-it/docs-drift",
  },
};

interface CapturedLog {
  readonly level: string;
  readonly msg: string;
  readonly fields: LogFields;
}

class CapturingLogger implements Logger {
  readonly entries: CapturedLog[] = [];

  debug(msg: string, fields?: LogFields): void {
    this.entries.push({ level: "debug", msg, fields: fields ?? {} });
  }
  info(msg: string, fields?: LogFields): void {
    this.entries.push({ level: "info", msg, fields: fields ?? {} });
  }
  warn(msg: string, fields?: LogFields): void {
    this.entries.push({ level: "warn", msg, fields: fields ?? {} });
  }
  error(msg: string, fields?: LogFields): void {
    this.entries.push({ level: "error", msg, fields: fields ?? {} });
  }
  with(): Logger {
    return this;
  }

  find(msg: string): CapturedLog | undefined {
    return this.entries.find((entry) => entry.msg === msg);
  }
}

async function buildTestRuntime(projects: ReadonlyArray<Project>): Promise<{
  runtime: Runtime;
  queue: LocalSelfPublishEntry[];
  logger: CapturingLogger;
  runner: FakeCodingAgentRunner;
}> {
  // Real descriptor + real skills tree: buildRuntime's startup compat gate
  // (verify-docs accepts claude-code, schemas inside the subset) runs on
  // every test.
  const descriptor = await loadDescriptorFromFile(DESCRIPTOR_PATH, { phase: "phase-2" });
  const queue: LocalSelfPublishEntry[] = [];
  const logger = new CapturingLogger();
  const runner = new FakeCodingAgentRunner("claude-code");
  runner.register("verify-docs", () => ({
    responseText: ["```json", JSON.stringify(CANNED_OUTPUT), "```"].join("\n"),
  }));
  const runtime = await buildRuntime({
    descriptor,
    catalog: new InMemoryCatalog(projects),
    workspace: new InMemoryWorkspace(),
    runners: new Map([["claude-code", runner]]),
    clients: {},
    logger,
    selfPublisher: createLocalSelfPublisher(queue),
    skillsDirs: [AGENT_SKILLS_DIR, defaultRuntimeSkillsDir()],
  });
  return { runtime, queue, logger, runner };
}

function initMessage(): RuntimeMessage<DocumentItPayload> {
  return {
    stage: "init",
    payload: {},
    metadata: {
      receivedAt: "2026-06-10T06:00:00.000Z",
      sourceTrigger: "scheduler",
      requestId: "tick-1",
    },
  };
}

function breakdownMessage(projectId: string): RuntimeMessage<DocumentItPayload> {
  return {
    stage: "breakdown",
    payload: { projectId },
    metadata: {
      receivedAt: "2026-06-10T06:01:00.000Z",
      sourceTrigger: "self",
      requestId: `fan-${projectId}`,
    },
  };
}

describe("document-it init fan-out", () => {
  it("publishes one breakdown message per explicitly opted-in project (strict enabled === true)", async () => {
    const { runtime, queue, logger, runner } = await buildTestRuntime([
      ENABLED_WITH_DOC_SET,
      EXPLICITLY_DISABLED,
      NO_EXTENSION,
    ]);

    await handleDocumentItMessage(initMessage(), runtime);

    // enabled:false is already filtered by forConsumer; the absent-extension
    // project survives the default-on view but MUST fail the strict filter.
    expect(queue).toHaveLength(1);
    expect(queue[0]?.body.stage).toBe("breakdown");
    expect(queue[0]?.body.payload).toEqual({ projectId: ENABLED_WITH_DOC_SET.id });
    expect(runner.invocations).toHaveLength(0);

    const log = logger.find("document-it: init fan-out complete");
    expect(log).toBeDefined();
    // The default-on consumer view keeps the absent-extension project as a
    // candidate; only the explicit opt-in is published.
    expect(log?.fields).toMatchObject({ candidateCount: 2, publishedCount: 1 });
  });

  it("publishes nothing when no project is explicitly opted in", async () => {
    const { runtime, queue } = await buildTestRuntime([EXPLICITLY_DISABLED, NO_EXTENSION]);

    await handleDocumentItMessage(initMessage(), runtime);

    expect(queue).toHaveLength(0);
  });
});

describe("document-it breakdown", () => {
  it("happy path — syncs, runs verify-docs with docSet passthrough, logs the audit summary", async () => {
    const { runtime, queue, logger, runner } = await buildTestRuntime([ENABLED_WITH_DOC_SET]);

    await handleDocumentItMessage(breakdownMessage(ENABLED_WITH_DOC_SET.id), runtime);

    expect(runner.invocations).toHaveLength(1);
    const invocation = runner.invocations[0]!;
    expect(invocation.entrypoint.name).toBe("verify-docs");
    expect(invocation.workingCopies).toHaveLength(1);
    expect(invocation.workingCopies[0]?.projectId).toBe(ENABLED_WITH_DOC_SET.id);

    // The rendered skill input carries the project source and the docSet
    // from extensions["document-it"].docSet verbatim.
    expect(invocation.renderedArguments).toContain("id: acme/widgets");
    expect(invocation.renderedArguments).toContain("url: https://github.com/acme/widgets.git");
    expect(invocation.renderedArguments).toContain("branch: main");
    expect(invocation.renderedArguments).toContain("space: WID");
    expect(invocation.renderedArguments).toContain('- "101"');
    expect(invocation.renderedArguments).toContain("- widgets-docs");

    // Structured summary log: drift counts by type + PR reference.
    const log = logger.find("document-it: audit complete");
    expect(log).toBeDefined();
    expect(log?.fields).toMatchObject({
      projectId: ENABLED_WITH_DOC_SET.id,
      summary: CANNED_OUTPUT.summary,
      inRepoDrift: { total: 2, stale: 1, wrong: 1, missing: 0 },
      publishedDrift: { total: 1, stale: 0, wrong: 0, missing: 1 },
      pullRequestUrl: CANNED_OUTPUT.pullRequest.url,
      pullRequestBranch: CANNED_OUTPUT.pullRequest.branch,
    });

    // No further fan-out from breakdown.
    expect(queue).toHaveLength(0);
  });

  it("defaults docSet to {} when the opt-in slice has none", async () => {
    const { runtime, runner } = await buildTestRuntime([ENABLED_NO_DOC_SET]);

    await handleDocumentItMessage(breakdownMessage(ENABLED_NO_DOC_SET.id), runtime);

    expect(runner.invocations).toHaveLength(1);
    const rendered = runner.invocations[0]!.renderedArguments;
    expect(rendered).toContain("docSet: {}");
  });

  it("skips a project that is in the catalog but not explicitly opted in", async () => {
    const { runtime, logger, runner } = await buildTestRuntime([NO_EXTENSION]);

    await handleDocumentItMessage(breakdownMessage(NO_EXTENSION.id), runtime);

    expect(runner.invocations).toHaveLength(0);
    const log = logger.find("document-it: project not explicitly opted in; skipping audit");
    expect(log?.fields).toMatchObject({ projectId: NO_EXTENSION.id });
  });

  it("skips a project that is missing from the catalog view", async () => {
    const { runtime, logger, runner } = await buildTestRuntime([ENABLED_WITH_DOC_SET]);

    await handleDocumentItMessage(breakdownMessage("acme/ghost"), runtime);

    expect(runner.invocations).toHaveLength(0);
    const log = logger.find("document-it: project not found in catalog view; skipping audit");
    expect(log?.fields).toMatchObject({ projectId: "acme/ghost" });
  });
});
