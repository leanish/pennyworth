import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defaultRuntimeSkillsDir } from "@leanish/runtime";
import { SkillLoader } from "@leanish/runtime/testing";

/**
 * Sanity-check that bump-it's two entry-point skills live in this
 * package and load cleanly via the runtime's `SkillLoader` (frontmatter
 * parses, schemas pass the runtime's schema-subset gate). The shared
 * support skill (`karpathy-guidelines`) is inherited from the runtime's
 * bundled skills/ via the multi-dir fallback, mirroring the production
 * search order.
 */
describe("agent-bump-it skills", () => {
  const agentSkillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

  it("bump-it loads as a valid entry-point skill", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    const skill = await loader.loadEntrypoint("bump-it");
    expect(skill.name).toBe("bump-it");
    expect(skill.compatibleCodingAgents).toEqual(["claude-code", "codex"]);
    expect(skill.inputSchema).toMatchObject({ type: "object", required: ["project"] });
    expect(skill.outputSchema).toMatchObject({
      type: "object",
      required: ["summary", "alerts", "pullRequests"],
    });
    expect(skill.body.length).toBeGreaterThan(0);
  });

  it("bump-it-revisit loads as a valid entry-point skill", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    const skill = await loader.loadEntrypoint("bump-it-revisit");
    expect(skill.name).toBe("bump-it-revisit");
    expect(skill.compatibleCodingAgents).toEqual(["claude-code", "codex"]);
    expect(skill.inputSchema).toMatchObject({
      type: "object",
      required: ["repo", "branch", "alertRef", "revisitCount"],
    });
    expect(skill.outputSchema).toMatchObject({
      type: "object",
      required: ["outcome", "ciConclusion"],
    });
    expect(skill.body.length).toBeGreaterThan(0);
  });

  it("inherits the karpathy-guidelines support skill from the runtime's bundled skills", async () => {
    const loader = new SkillLoader({
      skillsDirs: [agentSkillsDir, defaultRuntimeSkillsDir()],
    });
    const kg = await loader.load("karpathy-guidelines");
    expect(kg.name).toBe("karpathy-guidelines");
    expect(kg.body.length).toBeGreaterThan(0);
  });

  it("does NOT shadow universal support skills locally (they live in the runtime)", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    await expect(loader.load("karpathy-guidelines")).rejects.toThrow(
      /skill 'karpathy-guidelines' not found/,
    );
  });
});
