import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SkillLoader } from "@leanish/agent-runtime/testing";

/**
 * Sanity-check that ATC's agent-specific skills live in this package
 * and load cleanly via the runtime's `SkillLoader`. Per ADR-0001,
 * entry-point and agent-specific support skills live with the agent;
 * shared support skills (e.g. `karpathy-guidelines`) live in the
 * runtime's bundled `skills/` and are inherited via the multi-dir
 * search.
 */
describe("agent-atc skills", () => {
  // tsconfig.test.json maps __dirname-equivalent for ESM-style tests via
  // `import.meta.url`. The agent-atc package root is two levels up from
  // test/skills.test.ts.
  const agentSkillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

  // Mirrors the production search order: agent's own skills first,
  // then the runtime's bundled skills as the fallback for shared
  // support skills that live in @leanish/agent-runtime.
  const runtimeSkillsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "@leanish",
    "agent-runtime",
    "skills",
  );

  it("ask loads as a valid entry-point skill from agent-atc/skills/", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    const ask = await loader.loadEntrypoint("ask");
    expect(ask.name).toBe("ask");
    expect(ask.compatibleCodingAgents).toEqual(["claude-code", "codex"]);
    expect(ask.inputSchema).toMatchObject({ type: "object" });
    expect(ask.outputSchema).toMatchObject({ type: "object" });
    expect(ask.body.length).toBeGreaterThan(0);
  });

  it("falls through to the runtime for shared universal support skills (karpathy-guidelines, diagnose)", async () => {
    // Both `karpathy-guidelines` and `diagnose` are universal support
    // skills (no ATC-specific content in their bodies; every analytical
    // Layer-3 agent benefits from them). They live in
    // `agent-runtime/skills/` and ATC inherits them via the multi-dir
    // search fallback.
    const loader = new SkillLoader({
      skillsDirs: [agentSkillsDir, runtimeSkillsDir],
    });
    const kg = await loader.load("karpathy-guidelines");
    expect(kg.name).toBe("karpathy-guidelines");
    expect(kg.body.length).toBeGreaterThan(0);

    const d = await loader.load("diagnose");
    expect(d.name).toBe("diagnose");
    expect(d.body.length).toBeGreaterThan(0);
  });

  it("agent-atc/skills/ does NOT carry universal support skills (they live in the runtime)", async () => {
    // Sanity: without the runtime fallback, diagnose / karpathy-guidelines
    // are not findable from agent-atc/skills/ alone. They're universal,
    // so they live in agent-runtime/skills/, not here.
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    await expect(loader.load("diagnose")).rejects.toThrow(/skill 'diagnose' not found/);
    await expect(loader.load("karpathy-guidelines")).rejects.toThrow(
      /skill 'karpathy-guidelines' not found/,
    );
  });
});
