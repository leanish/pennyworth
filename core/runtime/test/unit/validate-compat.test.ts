import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { DescriptorValidationError } from "../../src/errors.js";
import { SkillLoader } from "../../src/skill/skill-loader.js";
import { validateSkillsCompatibility } from "../../src/skill/validate-compat.js";
import type { AgentDescriptor } from "../../src/types/descriptor.js";

const BASE: Omit<AgentDescriptor, "codingAgent"> = {
  identifier: "atc",
  compute: "lambda",
  triggers: [{ type: "consumer", queueArnRef: "q", dlqArnRef: "dlq", signedEnvelope: false }],
  stages: ["init"],
  model: "m",
  skills: { entrypoints: ["ask"], support: [] },
  needs: [],
  extensions: {},
};

describe("validateSkillsCompatibility", () => {
  let skillsDir: string;

  beforeAll(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), "agent-runtime-compat-"));
    await mkdir(join(skillsDir, "ask"), { recursive: true });
    await writeFile(
      join(skillsDir, "ask", "SKILL.md"),
      `---
name: ask
description: test
compatibleCodingAgents: [claude-code]
inputSchema:
  type: object
  required: [q]
  properties:
    q: { type: string }
outputSchema:
  type: object
  required: [a]
  properties:
    a: { type: string }
---

# ask
`,
    );
  });

  it("accepts a descriptor whose codingAgent is in the allowlist", async () => {
    const loader = new SkillLoader({ skillsDirs: [skillsDir] });
    await expect(
      validateSkillsCompatibility({ ...BASE, codingAgent: "claude-code" }, loader),
    ).resolves.toBeUndefined();
  });

  it("rejects a descriptor whose codingAgent is excluded by the skill", async () => {
    const loader = new SkillLoader({ skillsDirs: [skillsDir] });
    await expect(
      validateSkillsCompatibility({ ...BASE, codingAgent: "codex" }, loader),
    ).rejects.toBeInstanceOf(DescriptorValidationError);
  });

  it("buildRuntime runs the compat check before returning (custom-entry-shim path)", async () => {
    // The compat check used to live in run-local-cli only — a downstream
    // agent embedding `buildRuntime` directly in a custom Lambda module
    // would never see it. The check is now inside `buildRuntime`, so even
    // a path that never touches the CLI fails fast.
    const { buildRuntime } = await import("../../src/runtime/build-runtime.js");
    const { FakeCodingAgentRunner } = await import("../../src/skill/fake-runner.js");
    const { InMemoryCatalog } = await import("@leanish/catalog-it");
    const { InMemoryWorkspace } = await import("../../src/working-copy/in-memory-workspace.js");

    await expect(
      buildRuntime({
        descriptor: { ...BASE, codingAgent: "codex" },
        catalog: new InMemoryCatalog([]),
        workspace: new InMemoryWorkspace(),
        runners: new Map([["codex", new FakeCodingAgentRunner("codex")]]),
        clients: {},
        skillsDirs: [skillsDir],
      }),
    ).rejects.toBeInstanceOf(DescriptorValidationError);
  });

  it("buildRuntime skips the compat check when skipCompatCheck: true", async () => {
    const { buildRuntime } = await import("../../src/runtime/build-runtime.js");
    const { FakeCodingAgentRunner } = await import("../../src/skill/fake-runner.js");
    const { InMemoryCatalog } = await import("@leanish/catalog-it");
    const { InMemoryWorkspace } = await import("../../src/working-copy/in-memory-workspace.js");

    const runtime = await buildRuntime({
      descriptor: { ...BASE, codingAgent: "codex" },
      catalog: new InMemoryCatalog([]),
      workspace: new InMemoryWorkspace(),
      runners: new Map([["codex", new FakeCodingAgentRunner("codex")]]),
      clients: {},
      skillsDirs: [skillsDir],
      skipCompatCheck: true,
    });
    expect(runtime).toBeDefined();
  });
});
