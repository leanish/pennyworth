import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadDescriptorFromFile } from "@leanish/runtime";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESCRIPTOR_PATH = join(HERE, "..", "agent.yaml");

/**
 * The placeholder descriptor uses `type: scheduler`, which the runtime's
 * parser rejects by default (`DEFAULT_PHASE = "phase-1"`). This test
 * confirms the file is well-formed against the phase-2 parser — so the
 * pinned contract for phase-2 stays valid even though the deployable
 * isn't shippable in phase 1.
 *
 * If a future descriptor field is added that requires phase-3+ parsing,
 * bump the option below; if a phase-1 parser starts accepting scheduler
 * triggers, delete the explicit option.
 */
describe("agent-secureit/agent.yaml", () => {
  it("parses cleanly against the phase-2 parser", async () => {
    const descriptor = await loadDescriptorFromFile(DESCRIPTOR_PATH, { phase: "phase-2" });
    expect(descriptor.identifier).toBe("secureit");
    expect(descriptor.stages).toEqual(["init", "breakdown", "revisit"]);
    expect(descriptor.triggers).toHaveLength(1);
    expect(descriptor.triggers[0]?.type).toBe("scheduler");
    expect(descriptor.needs).toEqual(["github"]);
    expect(descriptor.skills.entrypoints).toEqual(["secureit", "secureit-revisit"]);
  });

  it("is rejected by the default (phase-1) parser — the descriptor is phase-2 contract", async () => {
    await expect(loadDescriptorFromFile(DESCRIPTOR_PATH)).rejects.toThrow();
  });
});
