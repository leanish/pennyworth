import { describe, expect, it } from "vitest";

import { runRelay } from "../src/index.js";
import type { Cli, RelayConfig } from "../src/index.js";
import { MockRunner, type Scripted, verdict } from "./helpers.js";

function relay(
  a1: readonly Scripted[],
  a2: readonly Scripted[],
  opts?: { prompt2?: string; rounds?: number; first?: Cli },
): RelayConfig {
  const first = opts?.first ?? "codex";
  const a2Cli: Cli = first === "codex" ? "claude" : "codex";
  return {
    prompt1: "the task",
    prompt2: opts?.prompt2,
    rounds: opts?.rounds ?? 5,
    first,
    agent1: new MockRunner(first, a1),
    agent2: new MockRunner(a2Cli, a2),
    agent1Resumed: false,
    agent2Resumed: false,
  };
}

describe("runRelay — settling", () => {
  it("settles when agent-2 (the responder) is done, then runs a synthesis turn", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("done"), verdict("done", { body: "CONSOLIDATED" })]));
    expect(out.status).toBe("settled");
    expect(out.roundsExecuted).toBe(1);
    expect(out.steps).toHaveLength(3); // agent-1, agent-2 (done), + synthesis on agent-2
    expect(out.steps.at(-1)?.slot).toBe("agent-2");
    expect(out.final.result).toBe("CONSOLIDATED");
    expect(out.continuation).toBeUndefined();
  });

  it("settles when agent-1 is done on a later turn (not the opener)", async () => {
    const out = await runRelay(
      relay([verdict("continue"), verdict("done")], [verdict("continue"), verdict("done", { body: "DONE" })]),
    );
    expect(out.status).toBe("settled");
    expect(out.roundsExecuted).toBe(2);
    expect(out.final.result).toBe("DONE");
  });

  it("does not let the opener (turn 1) end the run even if it returns done", async () => {
    const out = await runRelay(relay([verdict("done")], [verdict("continue")], { rounds: 1 }));
    expect(out.status).toBe("exhausted");
  });

  it("defers an opener needs-user to agent-2 instead of escalating on turn 1", async () => {
    // agent-1 (opener) needs-user, agent-2 resolves it (continue) → no escalation; budget then runs out
    const out = await runRelay(relay([verdict("needs-user")], [verdict("continue")], { rounds: 1 }));
    expect(out.status).toBe("exhausted");
    expect(out.steps).toHaveLength(2); // both ran; the opener's needs-user did not exit on turn 1
  });

  it("escalates when agent-2 still needs-user after a deferred opener needs-user", async () => {
    const out = await runRelay(relay([verdict("needs-user")], [verdict("needs-user")]));
    expect(out.status).toBe("needs-user");
    expect(out.steps).toHaveLength(2);
  });
});

describe("runRelay — non-settling outcomes", () => {
  it("exhausts the budget when no one is done", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("continue")], { rounds: 2 }));
    expect(out.status).toBe("exhausted");
    expect(out.roundsExecuted).toBe(2);
    expect(out.steps).toHaveLength(4);
    expect(out.final.disagreement).toBe("continue reason");
    expect(out.continuation).toBeDefined();
  });

  it("escalates immediately when any turn returns needs-user", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("needs-user")]));
    expect(out.status).toBe("needs-user");
    expect(out.steps).toHaveLength(2);
  });

  it("fails when an invocation throws", async () => {
    const out = await runRelay(relay([verdict("continue")], ["throw"]));
    expect(out.status).toBe("failed");
    expect(out.error).toContain("boom");
    expect(out.continuation).toBeUndefined();
  });

  it("fails on an error verdict, keeping its body", async () => {
    const out = await runRelay(relay([verdict("error", { body: "stacktrace" })], [verdict("done")]));
    expect(out.status).toBe("failed");
    expect(out.final.result).toBe("stacktrace");
    expect(out.steps).toHaveLength(1);
  });
});

describe("runRelay — action mode", () => {
  it("runs the same interleaved loop with prompt-2 set and synthesizes on settle", async () => {
    const out = await runRelay(
      relay([verdict("continue")], [verdict("done"), verdict("done", { body: "APPLIED+SUMMARY" })], { prompt2: "do it" }),
    );
    expect(out.status).toBe("settled");
    expect(out.final.result).toBe("APPLIED+SUMMARY");
  });
});

describe("runRelay — continuation & sessions", () => {
  it("captures both session ids", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("continue")], { rounds: 1 }));
    expect(out.sessions).toEqual({ codex: "codex-session", claude: "claude-session" });
  });

  it("omits --first in the continuation when it is the default (codex)", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("continue")], { rounds: 1, first: "codex" }));
    expect(out.continuation).toBeDefined();
    expect(out.continuation).not.toContain("--first");
    expect(out.continuation).toContain("--codex-session");
    expect(out.continuation).toContain("--claude-session");
  });

  it("includes --first claude in the continuation when roles are swapped", async () => {
    const out = await runRelay(relay([verdict("continue")], [verdict("continue")], { rounds: 1, first: "claude" }));
    expect(out.continuation).toContain("--first claude");
  });
});
