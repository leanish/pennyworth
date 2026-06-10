import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defaultRuntimeSkillsDir } from "@leanish/runtime/lambda";
import { SkillLoader } from "@leanish/runtime/testing";

/**
 * Sanity-check that triage-it's entry-point skill lives in this package
 * and loads cleanly via the runtime's `SkillLoader`, and that shared
 * support skills (`karpathy-guidelines`) are inherited from the runtime's
 * bundled `skills/` via the multi-dir search — mirroring the production
 * search order in `src/lambda.ts`.
 */
describe("triage-it skills", () => {
  const agentSkillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

  it("triage loads as a valid entry-point skill from triage-it/skills/", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    const triage = await loader.loadEntrypoint("triage");
    expect(triage.name).toBe("triage");
    expect(triage.compatibleCodingAgents).toEqual(["claude-code", "codex"]);
    expect(triage.inputSchema).toMatchObject({ type: "object" });
    expect(triage.outputSchema).toMatchObject({ type: "object" });
    expect(triage.body.length).toBeGreaterThan(0);
  });

  it("falls through to the runtime for the shared karpathy-guidelines support skill", async () => {
    const loader = new SkillLoader({
      skillsDirs: [agentSkillsDir, defaultRuntimeSkillsDir()],
    });
    const kg = await loader.load("karpathy-guidelines");
    expect(kg.name).toBe("karpathy-guidelines");
    expect(kg.body.length).toBeGreaterThan(0);
  });

  it("triage-it/skills/ does NOT carry universal support skills (they live in the runtime)", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    await expect(loader.load("karpathy-guidelines")).rejects.toThrow(
      /skill 'karpathy-guidelines' not found/,
    );
  });
});
