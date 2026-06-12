import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadDescriptorFromFile } from "@leanish/runtime";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIPTOR_PATH = join(HERE, "..", "agent.yaml");

/**
 * The descriptor uses `type: scheduler`, which the runtime's parser
 * rejects by default (`DEFAULT_PHASE = "phase-1"`). Entry shims (the
 * Lambda module, run-local) must parse it with `{ phase: "phase-2" }`.
 */
describe("agent-bump-it/agent.yaml", () => {
  it("parses cleanly against the phase-2 parser with the locked contract", async () => {
    const descriptor = await loadDescriptorFromFile(DESCRIPTOR_PATH, { phase: "phase-2" });
    expect(descriptor.identifier).toBe("bump-it");
    expect(descriptor.compute).toBe("lambda");
    expect(descriptor.stages).toEqual(["init", "breakdown", "revisit"]);
    expect(descriptor.triggers).toEqual([
      {
        type: "scheduler",
        queueArnRef: "bump-it-requests",
        dlqArnRef: "bump-it-requests-dlq",
      },
    ]);
    expect(descriptor.codingAgent).toBe("claude-code");
    expect(descriptor.model).toBe("claude-sonnet-4-6");
    expect(descriptor.skills.entrypoints).toEqual(["bump-it", "bump-it-revisit"]);
    expect(descriptor.skills.support).toEqual(["karpathy-guidelines"]);
    expect(descriptor.needs).toEqual(["github"]);
  });

  it("is rejected by the default (phase-1) parser — scheduler trigger is phase-2", async () => {
    await expect(loadDescriptorFromFile(DESCRIPTOR_PATH)).rejects.toThrow();
  });
});
