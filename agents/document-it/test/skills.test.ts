import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defaultRuntimeSkillsDir } from "@leanish/runtime";
import { SkillLoader } from "@leanish/runtime/testing";

/**
 * Real-skills compatibility check: document-it's entry-point skill lives
 * in this package and must load cleanly via the runtime's `SkillLoader`
 * (frontmatter parses, schemas pass the runtime's JSON-Schema subset)
 * and accept the descriptor's `codingAgent` (claude-code). Shared support
 * skills (`karpathy-guidelines`) fall through to the runtime's bundled
 * skills directory.
 */
describe("agent-document-it skills", () => {
  const agentSkillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

  it("verify-docs loads as a valid entry-point skill and accepts claude-code", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    const verifyDocs = await loader.loadEntrypoint("verify-docs");
    expect(verifyDocs.name).toBe("verify-docs");
    expect(verifyDocs.compatibleCodingAgents).toEqual(["claude-code", "codex"]);
    expect(verifyDocs.compatibleCodingAgents).toContain("claude-code");
    expect(verifyDocs.inputSchema).toMatchObject({ type: "object" });
    expect(verifyDocs.outputSchema).toMatchObject({ type: "object" });
    expect(verifyDocs.body.length).toBeGreaterThan(0);
  });

  it("falls through to the runtime for the shared karpathy-guidelines support skill", async () => {
    const loader = new SkillLoader({
      skillsDirs: [agentSkillsDir, defaultRuntimeSkillsDir()],
    });
    const kg = await loader.load("karpathy-guidelines");
    expect(kg.name).toBe("karpathy-guidelines");
    expect(kg.body.length).toBeGreaterThan(0);
  });

  it("agent-document-it/skills/ does NOT carry shared support skills (they live in the runtime)", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    await expect(loader.load("karpathy-guidelines")).rejects.toThrow(
      /skill 'karpathy-guidelines' not found/,
    );
  });
});
