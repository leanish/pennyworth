import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadDescriptorFromFile } from "@leanish/runtime";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIPTOR_PATH = join(HERE, "..", "agent.yaml");

/**
 * The descriptor uses `type: scheduler`, which the runtime's parser
 * rejects by default (`DEFAULT_PHASE = "phase-1"`). The Lambda entry
 * (`src/lambda.ts`) loads it with `{ phase: "phase-2" }`; these tests pin
 * both sides of that contract.
 */
describe("agent-document-it/agent.yaml", () => {
  it("parses cleanly against the phase-2 parser", async () => {
    const descriptor = await loadDescriptorFromFile(DESCRIPTOR_PATH, { phase: "phase-2" });
    expect(descriptor.identifier).toBe("document-it");
    expect(descriptor.compute).toBe("lambda");
    expect(descriptor.stages).toEqual(["init", "breakdown"]);
    expect(descriptor.triggers).toHaveLength(1);
    expect(descriptor.triggers[0]).toEqual({
      type: "scheduler",
      queueArnRef: "document-it-requests",
      dlqArnRef: "document-it-requests-dlq",
    });
    expect(descriptor.codingAgent).toBe("claude-code");
    expect(descriptor.model).toBe("claude-sonnet-4-6");
    expect(descriptor.skills.entrypoints).toEqual(["verify-docs"]);
    expect(descriptor.skills.support).toEqual(["karpathy-guidelines"]);
    expect(descriptor.needs).toEqual(["github"]);
  });

  it("is rejected by the default (phase-1) parser — scheduler triggers are phase-2", async () => {
    await expect(loadDescriptorFromFile(DESCRIPTOR_PATH)).rejects.toThrow();
  });
});
