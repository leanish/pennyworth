import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryCatalog, type Project } from "@leanish/catalog-it";
import { beforeAll, describe, expect, it } from "vitest";

import { parseDescriptor } from "../../src/descriptor/parse.js";
import { defineAgent } from "../../src/define-agent.js";
import { ConsoleLogger } from "../../src/logger/console-logger.js";
import { buildRuntime } from "../../src/runtime/build-runtime.js";
import { runLocal } from "../../src/runtime/run-local.js";
import { FakeCodingAgentRunner } from "../../src/skill/fake-runner.js";
import { InMemoryWorkspace } from "../../src/working-copy/in-memory-workspace.js";
import type { AgentDefinition } from "../../src/types/agent.js";
import type { AgentPayloadBase } from "../../src/types/execution-override.js";
import type { RuntimeMessage } from "../../src/types/runtime-message.js";

/**
 * End-to-end exercise of the local-mode dispatch path:
 *
 *   descriptor → defineAgent → buildRuntime → runLocal → dispatch → handle
 *     → runtime.catalog → runtime.syncWorkingCopies → runtime.runSkill
 *       → SkillLoader → SchemaValidator → renderInput → FakeRunner
 *       → extractTerminalJson → outputSchema validation → typed result
 *
 * Uses an in-memory catalog + in-memory workspace + fake coding-agent
 * runner, so the test runs in <100ms and doesn't hit disk or network
 * for the skill execution.
 *
 * The bundled `ask` skill is written into a per-test temp dir; the runtime
 * is told to look there via `skillsDir`.
 */

const ATC_YAML = `
identifier: atc
compute: lambda
triggers:
  - type: consumer
    queueArnRef: atc-requests
    dlqArnRef: atc-requests-dlq
    signedEnvelope: true
stages: [init]
codingAgent: claude-code
model: claude-sonnet-4-6
skills:
  entrypoints:
    - ask
needs: []
`;

const ASK_SKILL_FILE = `---
description: Answer a question about the codebase
inputSchema:
  type: object
  additionalProperties: false
  required: [question]
  properties:
    question:
      type: string
      description: The question to answer.
outputSchema:
  type: object
  additionalProperties: false
  required: [answer]
  properties:
    answer:
      type: string
      description: The answer.
---

# ask

Answer the question. Respond with a final fenced-json block.
`;

const PROJECT: Project = {
  id: "leanish/atc",
  source: { url: "https://github.com/leanish/atc.git", branch: "main" },
  extensions: { atc: { enabled: true } },
};

interface AskInput {
  question: string;
}
interface AskOutput {
  answer: string;
}
interface AskPayload extends AgentPayloadBase {
  question: string;
}

describe("end-to-end local-mode dispatch", () => {
  let skillsDir: string;

  beforeAll(async () => {
    const tmp = await mkdtemp(join(tmpdir(), "agent-runtime-e2e-"));
    skillsDir = join(tmp, "skills");
    await mkdir(join(skillsDir, "ask"), { recursive: true });
    await writeFile(join(skillsDir, "ask", "SKILL.md"), ASK_SKILL_FILE);
  });

  it("dispatches a consumer-trigger init message and returns a typed result", async () => {
    const descriptor = parseDescriptor(ATC_YAML);
    const catalog = new InMemoryCatalog([PROJECT]);
    const workspace = new InMemoryWorkspace();

    const runner = new FakeCodingAgentRunner("claude-code");
    runner.register("ask", (invocation) => {
      // Verify the runtime rendered the input correctly into $ARGUMENTS.
      expect(invocation.renderedArguments).toBe("question: What does auth do?");
      expect(invocation.entrypoint.name).toBe("ask");
      expect(invocation.workingCopies).toHaveLength(1);
      expect(invocation.workingCopies[0]?.projectId).toBe("leanish/atc");
      return {
        responseText: [
          "<thinking>scanning…</thinking>",
          "",
          "```json",
          '{"answer": "auth handles signin and JWT issuance."}',
          "```",
        ].join("\n"),
      };
    });

    // Capture handler output for assertion.
    let captured: AskOutput | undefined;

    const agent: AgentDefinition<AskPayload> = defineAgent<AskPayload>({
      identifier: "atc",
      async handle(message, runtime) {
        const project = runtime.catalog.forConsumer("atc").get("leanish/atc");
        expect(project).toBeDefined();
        const sync = await runtime.syncWorkingCopies([project!]);
        expect(sync.report[0]).toMatchObject({ outcome: "cloned" });
        captured = await runtime.runSkill<AskInput, AskOutput>({
          entrypoint: "ask",
          input: { question: message.payload.question },
          workingCopies: sync.workingCopies,
        });
      },
    });

    const runtime = await buildRuntime({
      descriptor,
      catalog,
      workspace,
      runners: new Map([["claude-code", runner]]),
      clients: {},
      logger: new ConsoleLogger({ minLevel: "error" }),
      skillsDirs: [skillsDir],
    });

    const message: RuntimeMessage<AskPayload> = {
      stage: "init",
      payload: { question: "What does auth do?" },
      metadata: {
        receivedAt: "2026-05-22T00:00:00.000Z",
        sourceTrigger: "consumer",
        requestId: "msg-e2e-1",
      },
    };

    await runLocal({ agent, descriptor, runtime, message });
    expect(captured).toEqual({ answer: "auth handles signin and JWT issuance." });
    expect(runner.invocations).toHaveLength(1);
  });

  it("rejects messages whose stage isn't declared", async () => {
    const descriptor = parseDescriptor(ATC_YAML);
    const agent = defineAgent<AskPayload>({
      identifier: "atc",
      async handle() {
        throw new Error("must not be called");
      },
    });
    const runtime = await buildRuntime({
      descriptor,
      catalog: new InMemoryCatalog([PROJECT]),
      workspace: new InMemoryWorkspace(),
      runners: new Map([["claude-code", new FakeCodingAgentRunner("claude-code")]]),
      clients: {},
      logger: new ConsoleLogger({ minLevel: "error" }),
      skillsDirs: [skillsDir],
    });

    const message = {
      stage: "breakdown",
      payload: { question: "ignored" },
      metadata: {
        receivedAt: "2026-05-22T00:00:00.000Z",
        sourceTrigger: "consumer",
        requestId: "msg-e2e-2",
      },
    } as RuntimeMessage<AskPayload>;

    await expect(runLocal({ agent, descriptor, runtime, message })).rejects.toThrowError(
      /not in its declared stages/,
    );
  });
});
