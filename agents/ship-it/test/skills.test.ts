import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defaultRuntimeSkillsDir } from "@leanish/runtime";
import { SkillLoader } from "@leanish/runtime/testing";

/**
 * ship-it's entry-point skills live in this package (per ADR-0001); the
 * shared support skill (`karpathy-guidelines`) is inherited from the
 * runtime's bundled skills via the multi-dir search fallback.
 */
describe("agent-ship-it skills", () => {
  const agentSkillsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

  it("code-it loads as a valid entry-point skill compatible with the configured coding agent", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    const skill = await loader.loadEntrypoint("code-it");
    expect(skill.name).toBe("code-it");
    expect(skill.compatibleCodingAgents).toContain("claude-code");
    expect(skill.inputSchema).toMatchObject({ type: "object" });
    expect(skill.outputSchema).toMatchObject({
      type: "object",
      required: ["outcome", "notes"],
    });
    expect(skill.body.length).toBeGreaterThan(0);
  });

  it("code-it-revisit loads as a valid entry-point skill compatible with the configured coding agent", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    const skill = await loader.loadEntrypoint("code-it-revisit");
    expect(skill.name).toBe("code-it-revisit");
    expect(skill.compatibleCodingAgents).toContain("claude-code");
    expect(skill.inputSchema).toMatchObject({
      type: "object",
      required: ["ticketKey", "projectId", "prNumber", "branch", "revisitCount"],
    });
    expect(skill.outputSchema).toMatchObject({
      type: "object",
      required: ["outcome", "ciConclusion"],
    });
    expect(skill.body.length).toBeGreaterThan(0);
  });

  it("validate-it loads as a valid entry point with the read-only verification contract", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    const validateIt = await loader.loadEntrypoint("validate-it");
    expect(validateIt.compatibleCodingAgents).toContain("claude-code");
    expect(validateIt.inputSchema).toMatchObject({
      type: "object",
      required: ["ticketKey", "projectId", "ticketSummary", "validation"],
    });
    expect(validateIt.outputSchema).toMatchObject({
      type: "object",
      required: ["outcome", "checks", "summary", "notes"],
    });
  });

  it("the dark steps' skills load as valid entry points (groom-it, spec-it, review-it)", async () => {
    const loader = new SkillLoader({ skillsDirs: [agentSkillsDir] });

    const groomIt = await loader.loadEntrypoint("groom-it");
    expect(groomIt.compatibleCodingAgents).toContain("claude-code");
    expect(groomIt.inputSchema).toMatchObject({
      type: "object",
      required: ["ticketKey", "projectId", "ticketSummary", "labels"],
    });
    expect(groomIt.outputSchema).toMatchObject({
      type: "object",
      required: ["outcome", "findings", "notes"],
    });

    const specIt = await loader.loadEntrypoint("spec-it");
    expect(specIt.compatibleCodingAgents).toContain("claude-code");
    expect(specIt.inputSchema).toMatchObject({
      type: "object",
      required: ["ticketKey", "ticketSummary", "project"],
    });
    expect(specIt.outputSchema).toMatchObject({
      type: "object",
      required: ["outcome", "specDraft", "openQuestions", "suggestReady", "notes"],
    });

    const reviewIt = await loader.loadEntrypoint("review-it");
    expect(reviewIt.compatibleCodingAgents).toContain("claude-code");
    expect(reviewIt.inputSchema).toMatchObject({
      type: "object",
      required: ["projectId", "prNumber"],
    });
    expect(reviewIt.outputSchema).toMatchObject({
      type: "object",
      required: ["outcome", "verificationMode", "findings", "summary", "postedReview"],
    });
  });

  it("inherits karpathy-guidelines from the runtime's bundled skills (not duplicated here)", async () => {
    const own = new SkillLoader({ skillsDirs: [agentSkillsDir] });
    await expect(own.load("karpathy-guidelines")).rejects.toThrow(
      /skill 'karpathy-guidelines' not found/,
    );

    const withFallback = new SkillLoader({
      skillsDirs: [agentSkillsDir, defaultRuntimeSkillsDir()],
    });
    const kg = await withFallback.load("karpathy-guidelines");
    expect(kg.name).toBe("karpathy-guidelines");
    expect(kg.body.length).toBeGreaterThan(0);
  });
});
