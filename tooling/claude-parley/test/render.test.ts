import { describe, expect, it } from "vitest";

import { renderResultDocument, renderSteps, renderText, runRelay } from "../src/index.js";
import type { RelayConfig } from "../src/index.js";
import { MockRunner, type Scripted, verdict } from "./helpers.js";

function relay(a1: readonly Scripted[], a2: readonly Scripted[], rounds = 5): RelayConfig {
  return {
    prompt1: "the task",
    prompt2: undefined,
    rounds,
    first: "codex",
    agent1: new MockRunner("codex", a1),
    agent2: new MockRunner("claude", a2),
    agent1Resumed: false,
    agent2Resumed: false,
  };
}

describe("renderText", () => {
  it("shows status and the final body, with no continuation when settled", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("done"), verdict("done", { body: "result text" })]));
    const text = renderText(out);
    expect(text).toContain("status: settled");
    expect(text).toContain("result text");
    expect(text).not.toContain("Continue with:");
  });

  it("prints the continuation command when the budget is exhausted", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("continue")], 1));
    const text = renderText(out);
    expect(text).toContain("status: exhausted");
    expect(text).toContain("Continue with:");
  });
});

describe("renderResultDocument", () => {
  it("omits steps and the internal error field, includes continuation when present", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("continue")], 1));
    const doc = JSON.parse(renderResultDocument(out)) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("steps");
    expect(doc).not.toHaveProperty("error");
    expect(doc).toHaveProperty("continuation");
    expect(doc).toHaveProperty("sessions");
    expect(doc.first).toBe("codex");
  });

  it("omits continuation when settled", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("done"), verdict("done")]));
    const doc = JSON.parse(renderResultDocument(out)) as Record<string, unknown>;
    expect(doc).not.toHaveProperty("continuation");
  });
});

describe("renderSteps", () => {
  it("emits one entry per turn", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("done"), verdict("done")]));
    const steps = JSON.parse(renderSteps(out.steps)) as unknown[];
    expect(steps).toHaveLength(3); // agent-1, agent-2 (done), synthesis
  });
});
