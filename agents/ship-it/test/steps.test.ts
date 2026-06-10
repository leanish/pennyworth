import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadDescriptorFromFile } from "@leanish/runtime";

import { releasedSteps, SHIP_IT_STEPS } from "../src/steps.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("ship-it step registry", () => {
  it("the live rollout releases exactly groom-it (least brittle first; the rest are WiP dark)", () => {
    expect(releasedSteps()).toEqual(["groom-it"]);
  });

  it("covers the full lifecycle vocabulary, dark steps included", () => {
    expect(Object.keys(SHIP_IT_STEPS).sort()).toEqual([
      "code-it",
      "groom-it",
      "mock-it-up",
      "review-it",
      "spec-it",
      "validate-it",
    ]);
  });

  it("every released step is a declared skill entrypoint", async () => {
    // A step flipped to released must have its skill shipped and declared —
    // otherwise runSkill would reject at runtime. Pin the invariant here so
    // releasing a step without its skill fails in CI, not in Lambda.
    const descriptor = await loadDescriptorFromFile(join(HERE, "..", "agent.yaml"));
    for (const step of releasedSteps()) {
      expect(descriptor.skills.entrypoints).toContain(step);
    }
  });
});
