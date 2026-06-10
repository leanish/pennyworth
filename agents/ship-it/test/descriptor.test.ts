import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadDescriptorFromFile } from "@leanish/runtime";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIPTOR_PATH = join(HERE, "..", "agent.yaml");

/**
 * ship-it pairs a phase-1 `consumer` trigger with the phase-2 `revisit`
 * stage — stages and trigger types are orthogonal (ADR-0012), so the
 * DEFAULT parser phase must accept the descriptor as-is.
 */
describe("agent-ship-it/agent.yaml", () => {
  it("parses cleanly with the default parser phase", async () => {
    const descriptor = await loadDescriptorFromFile(DESCRIPTOR_PATH);
    expect(descriptor.identifier).toBe("ship-it");
    expect(descriptor.compute).toBe("lambda");
    expect(descriptor.stages).toEqual(["init", "revisit"]);
    expect(descriptor.triggers).toEqual([
      {
        type: "consumer",
        queueArnRef: "ship-it-requests",
        dlqArnRef: "ship-it-requests-dlq",
        signedEnvelope: true,
      },
    ]);
    expect(descriptor.codingAgent).toBe("claude-code");
    expect(descriptor.model).toBe("claude-sonnet-4-6");
    expect(descriptor.skills.entrypoints).toEqual([
      "code-it",
      "code-it-revisit",
      "groom-it",
      "spec-it",
      "review-it",
    ]);
    expect(descriptor.skills.support).toEqual(["karpathy-guidelines"]);
    expect(descriptor.needs).toEqual(["github", "jira"]);
  });
});
