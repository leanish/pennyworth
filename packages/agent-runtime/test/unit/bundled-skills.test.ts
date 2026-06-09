import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SkillLoader } from "../../src/skill/skill-loader.js";

const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");

/**
 * The runtime's bundled `skills/` directory hosts **universal support
 * skills** that every agent inherits unless they shadow them by name.
 *
 * Agent-specific entry-point skills (e.g. ATC's `ask` — whose
 * `outputSchema` is ATC's terminal-reply shape) live in the owning
 * agent's package per ADR-0001 § Amendment. See
 * `agent-atc/test/skills.test.ts` for coverage of those + the
 * multi-dir fallback into here.
 */
describe("bundled skills under agent-runtime/skills/", () => {
  it("karpathy-guidelines loads as a universal support skill", async () => {
    const loader = new SkillLoader({ skillsDirs: [skillsDir] });
    const kg = await loader.load("karpathy-guidelines");
    expect(kg.name).toBe("karpathy-guidelines");
    expect(kg.body.length).toBeGreaterThan(0);
  });

  it("diagnose loads as a universal support skill (debugging methodology — no agent-specific content)", async () => {
    const loader = new SkillLoader({ skillsDirs: [skillsDir] });
    const d = await loader.load("diagnose");
    expect(d.name).toBe("diagnose");
    expect(d.body.length).toBeGreaterThan(0);
    // The diagnose skill body is pure methodology (reproduce →
    // minimise → hypothesise → instrument → fix → regression-test);
    // nothing in it should mention ATC, since it's shared substrate
    // every analytical Layer-3 agent benefits from.
    expect(d.body.toLowerCase()).not.toContain("atc");
  });

  it("does NOT carry agent-specific skills (e.g. ATC's `ask` lives in agent-atc/skills/)", async () => {
    const loader = new SkillLoader({ skillsDirs: [skillsDir] });
    await expect(loader.load("ask")).rejects.toThrow(/skill 'ask' not found/);
  });
});
