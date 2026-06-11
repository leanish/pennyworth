import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  GetObjectRequest,
  GetObjectResult,
  Runtime,
  RuntimeMessage,
  S3Client,
  SqsClient,
} from "@leanish/runtime";
import {
  buildRuntime,
  defaultRuntimeSkillsDir,
  loadDescriptorFromFile,
} from "@leanish/runtime/lambda";
import {
  FakeCodingAgentRunner,
  InMemoryCatalog,
  InMemoryEventBus,
  InMemorySqsBus,
  InMemoryWorkspace,
  type Project,
} from "@leanish/runtime/testing";

import { handleTriageMessage } from "../src/handler.js";
import type { TriagePayload } from "../src/payload.js";

import { makeTarGz } from "./helpers/tar-fixture.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const PROJECT: Project = {
  id: "leanish/agent-runtime",
  source: { url: "https://github.com/leanish/agent-runtime.git", branch: "main" },
  extensions: {},
};

const EVIDENCE_URI = "s3://evidence-bucket/customer-1/SUP-1234.tar.gz";

const EVIDENCE_ARCHIVE = makeTarGz([
  { path: "manifest.md", content: "# evidence for customer-1 / SUP-1234\n" },
  { path: "config/settings.json", content: '{"feature":{"enabled":false}}' },
]);

const CANNED_OUTPUT = {
  diagnosis: "The feature flag is disabled in the customer configuration.",
  findings: [
    { category: "config", finding: "feature.enabled is false", confidence: 0.9 },
  ],
  suggestedNextSteps: ["Confirm with the customer and re-enable feature.enabled."],
  relevantPriorTickets: [
    { ticketKey: "SUP-100", note: "same flag; resolved by re-enabling it" },
  ],
};

interface Harness {
  readonly runtime: Runtime;
  readonly events: InMemoryEventBus;
  readonly sqs: InMemorySqsBus;
  readonly runner: FakeCodingAgentRunner;
  /** evidenceDir observed by the fake skill run, with manifest-on-disk flag. */
  readonly observed: { evidenceDir?: string; manifestExisted?: boolean };
}

async function buildHarness(
  overrides: {
    readonly s3Objects?: ReadonlyMap<string, Uint8Array>;
    readonly sqsClient?: SqsClient;
  } = {},
): Promise<Harness> {
  const descriptor = await loadDescriptorFromFile(join(packageRoot, "agent.yaml"));
  const events = new InMemoryEventBus();
  const sqs = new InMemorySqsBus();
  const observed: Harness["observed"] = {};

  const objects =
    overrides.s3Objects ?? new Map<string, Uint8Array>([[EVIDENCE_URI, EVIDENCE_ARCHIVE]]);
  const s3: S3Client = {
    async getObject(args: GetObjectRequest): Promise<GetObjectResult> {
      const body = objects.get(`s3://${args.bucket}/${args.key}`);
      if (body === undefined) {
        throw new Error(`NoSuchKey: s3://${args.bucket}/${args.key}`);
      }
      return { body };
    },
  };

  const runner = new FakeCodingAgentRunner("claude-code", [
    {
      entrypoint: "triage",
      respond: (invocation) => {
        // The rendered input carries the evidenceDir path; capture it (and
        // whether the manifest was on disk during the run) so tests can
        // assert extraction-before-skill and cleanup-after-handler.
        const evidenceDir = /evidenceDir: (\S+)/.exec(invocation.renderedArguments)?.[1];
        if (evidenceDir !== undefined) {
          observed.evidenceDir = evidenceDir;
          observed.manifestExisted = existsSync(join(evidenceDir, "manifest.md"));
        }
        return {
          responseText: ["```json", JSON.stringify(CANNED_OUTPUT), "```"].join("\n"),
        };
      },
    },
  ]);

  const runtime = await buildRuntime({
    descriptor,
    catalog: new InMemoryCatalog([PROJECT]),
    workspace: new InMemoryWorkspace(),
    runners: new Map([["claude-code", runner]]),
    clients: { s3, sqs: overrides.sqsClient ?? sqs, eventbridge: events },
    skillsDirs: [join(packageRoot, "skills"), defaultRuntimeSkillsDir()],
  });

  return { runtime, events, sqs, runner, observed };
}

function makeMessage(request: unknown): RuntimeMessage<TriagePayload> {
  return {
    stage: "init",
    payload: {
      envelope: {
        kind: "triage",
        requestId: "triage-req-1",
        consumer: "support-tooling",
        endUser: "support:U1",
        timestamp: "2026-06-10T00:00:00.000Z",
        replyTo: "arn:aws:sqs:us-east-1:000000000000:triage-replies",
      },
      request: request as TriagePayload["request"],
    },
    metadata: {
      receivedAt: "2026-06-10T00:00:00.000Z",
      sourceTrigger: "consumer",
      requestId: "sqs-msg-1",
    },
  };
}

const VALID_REQUEST = {
  ticketKey: "SUP-1234",
  customer: "customer-1",
  evidenceBlobUri: EVIDENCE_URI,
  problem: "recommendations are empty since Tuesday",
};

describe("handleTriageMessage", () => {
  it("happy path with projectIds — code+evidence scope, reply delivered, lifecycle emitted", async () => {
    const { runtime, events, sqs, runner, observed } = await buildHarness();

    const reply = await handleTriageMessage(
      makeMessage({ ...VALID_REQUEST, projectIds: [PROJECT.id] }),
      runtime,
    );

    // Terminal reply: returned AND delivered to envelope.replyTo.
    expect(sqs.messages).toHaveLength(1);
    expect(sqs.messages[0]!.request.queueArn).toBe(
      "arn:aws:sqs:us-east-1:000000000000:triage-replies",
    );
    const delivered = JSON.parse(sqs.messages[0]!.request.body);
    expect(delivered).toEqual(reply);
    expect(delivered).toMatchObject({
      requestId: "triage-req-1",
      status: "completed",
      result: {
        ...CANNED_OUTPUT,
        codeScope: "code+evidence",
        agent: { kind: "claude-code", model: "claude-sonnet-4-6" },
      },
    });
    expect(typeof delivered.result.durationMs).toBe("number");

    // Lifecycle protocol: received → completed, with correlation fields.
    expect(events.entries.map((e) => e.detailType)).toEqual([
      "triage-it.triage.received",
      "triage-it.triage.completed",
    ]);
    expect(events.entries[0]!.source).toBe("triage-it");
    expect(events.entries[0]!.detail).toMatchObject({
      requestId: "triage-req-1",
      consumer: "support-tooling",
      endUser: "support:U1",
      ticketKey: "SUP-1234",
    });
    expect(events.entries[1]!.detail).toMatchObject({ codeScope: "code+evidence" });

    // The skill ran with the synced working copy and a populated evidence dir…
    expect(runner.invocations).toHaveLength(1);
    expect(runner.invocations[0]!.workingCopies.map((wc) => wc.projectId)).toEqual([
      PROJECT.id,
    ]);
    expect(runner.invocations[0]!.renderedArguments).toContain("codeScope: code+evidence");
    expect(runner.invocations[0]!.renderedArguments).toContain("ticketKey: SUP-1234");
    expect(observed.manifestExisted).toBe(true);
    // …and the evidence dir is cleaned up once the handler returns.
    expect(existsSync(observed.evidenceDir!)).toBe(false);
  });

  it("no projectIds — evidence-only fallback with no working copies", async () => {
    const { runtime, sqs, runner } = await buildHarness();

    await handleTriageMessage(makeMessage(VALID_REQUEST), runtime);

    expect(runner.invocations).toHaveLength(1);
    expect(runner.invocations[0]!.workingCopies).toEqual([]);
    expect(runner.invocations[0]!.renderedArguments).toContain("codeScope: evidence-only");
    const delivered = JSON.parse(sqs.messages[0]!.request.body);
    expect(delivered.result.codeScope).toBe("evidence-only");
  });

  it("invalid request — terminal validation-error reply, no skill run", async () => {
    const { runtime, events, sqs, runner } = await buildHarness();

    const reply = await handleTriageMessage(
      makeMessage({ customer: "customer-1" }), // missing ticketKey + evidenceBlobUri
      runtime,
    );

    expect(reply).toMatchObject({ status: "failed", error: { kind: "validation-error" } });
    expect(runner.invocations).toHaveLength(0);
    expect(events.entries.map((e) => e.detailType)).toEqual([
      "triage-it.triage.received",
      "triage-it.triage.failed",
    ]);
    const delivered = JSON.parse(sqs.messages[0]!.request.body);
    expect(delivered.status).toBe("failed");
  });

  it("archive without manifest.md — terminal 'invalid evidence archive' validation error", async () => {
    const badArchive = makeTarGz([{ path: "config/settings.json", content: "{}" }]);
    const { runtime, runner } = await buildHarness({
      s3Objects: new Map([[EVIDENCE_URI, badArchive]]),
    });

    const reply = await handleTriageMessage(makeMessage(VALID_REQUEST), runtime);

    expect(reply).toMatchObject({ status: "failed", error: { kind: "validation-error" } });
    expect(reply.status === "failed" && reply.error.message).toContain(
      "invalid evidence archive",
    );
    expect(runner.invocations).toHaveLength(0);
  });

  it("archive with a traversal entry — terminal validation error, no skill run", async () => {
    const evilArchive = makeTarGz([
      { path: "manifest.md", content: "# manifest" },
      { path: "../escape.txt", content: "pwned" },
    ]);
    const { runtime, runner } = await buildHarness({
      s3Objects: new Map([[EVIDENCE_URI, evilArchive]]),
    });

    const reply = await handleTriageMessage(makeMessage(VALID_REQUEST), runtime);

    expect(reply).toMatchObject({ status: "failed", error: { kind: "validation-error" } });
    expect(reply.status === "failed" && reply.error.message).toContain(
      "invalid evidence archive",
    );
    expect(runner.invocations).toHaveLength(0);
  });

  it("unknown projectIds — terminal validation error naming the id (no silent skip)", async () => {
    const { runtime, runner } = await buildHarness();

    const reply = await handleTriageMessage(
      makeMessage({ ...VALID_REQUEST, projectIds: ["leanish/does-not-exist"] }),
      runtime,
    );

    expect(reply).toMatchObject({ status: "failed", error: { kind: "validation-error" } });
    expect(reply.status === "failed" && reply.error.message).toContain(
      "leanish/does-not-exist",
    );
    expect(runner.invocations).toHaveLength(0);
  });

  it("evidence blob missing in S3 — terminal io-error", async () => {
    const { runtime, events } = await buildHarness({
      s3Objects: new Map(),
    });

    const reply = await handleTriageMessage(makeMessage(VALID_REQUEST), runtime);

    expect(reply).toMatchObject({ status: "failed", error: { kind: "io-error" } });
    expect(events.entries.map((e) => e.detailType)).toEqual([
      "triage-it.triage.received",
      "triage-it.triage.failed",
    ]);
  });

  it("post-completion delivery failure propagates for SQS retry — completed already emitted, never failed", async () => {
    const throwingSqs: SqsClient = {
      async sendMessage() {
        throw new Error("sqs sendMessage failed");
      },
    };
    const { runtime, events } = await buildHarness({ sqsClient: throwingSqs });

    await expect(handleTriageMessage(makeMessage(VALID_REQUEST), runtime)).rejects.toThrow(
      /sqs sendMessage failed/,
    );

    const detailTypes = events.entries.map((e) => e.detailType);
    expect(detailTypes).toContain("triage-it.triage.completed");
    expect(detailTypes).not.toContain("triage-it.triage.failed");
  });
});
