import { describe, expect, it } from "vitest";

import { planSlots } from "../src/index.js";

describe("planSlots", () => {
  it("defaults to codex as agent-1 (plan lead) and claude as agent-2", () => {
    const plan = planSlots({ first: "codex", claudeSession: undefined, codexSession: undefined });
    expect(plan.agent1Cli).toBe("codex");
    expect(plan.agent2Cli).toBe("claude");
    expect(plan.agent1Resumed).toBe(false);
    expect(plan.agent2Resumed).toBe(false);
  });

  it("swaps slots when --first claude", () => {
    const plan = planSlots({ first: "claude", claudeSession: undefined, codexSession: undefined });
    expect(plan.agent1Cli).toBe("claude");
    expect(plan.agent2Cli).toBe("codex");
  });

  it("marks only the claude slot resumed when only --claude-session is given", () => {
    const plan = planSlots({ first: "codex", claudeSession: "c1", codexSession: undefined });
    // claude is agent-2 here
    expect(plan.agent2Resumed).toBe(true);
    expect(plan.agent1Resumed).toBe(false);
  });

  it("marks only the codex slot resumed when only --codex-session is given", () => {
    const plan = planSlots({ first: "codex", claudeSession: undefined, codexSession: "x1" });
    // codex is agent-1 here
    expect(plan.agent1Resumed).toBe(true);
    expect(plan.agent2Resumed).toBe(false);
  });

  it("marks both resumed when both ids are given", () => {
    const plan = planSlots({ first: "codex", claudeSession: "c1", codexSession: "x1" });
    expect(plan.agent1Resumed).toBe(true);
    expect(plan.agent2Resumed).toBe(true);
  });
});
