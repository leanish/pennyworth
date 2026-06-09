import { describe, expect, it } from "vitest";
import { CodingAgentInvocationError, runParley } from "../src/index.js";
import { scriptedRunners, verdict } from "./helpers.js";

describe("runParley", () => {
  it("settles when both slots agree in the same round", async () => {
    const { runners } = scriptedRunners({
      codex: [verdict("agree", "reviewer approves")],
      claude: [verdict("agree", "actor concurs")],
    });

    const output = await runParley({
      prompt1: "review this change",
      rounds: 5,
      first: "codex",
      sessions: {},
      runners,
    });

    expect(output.exitCode).toBe(0);
    expect(output.result).toEqual({
      status: "settled",
      roundsExecuted: 1,
      maxRounds: 5,
      first: "codex",
      sessions: {
        claude: "claude-session",
        codex: "codex-session",
      },
      final: {
        summary: "agree summary",
        result: "actor concurs",
        agreement: "agree summary",
        disagreement: null,
      },
    });
    expect(output.steps).toHaveLength(2);
  });

  it("passes reviewer needs-user to the actor before escalating", async () => {
    const { runners, invocations } = scriptedRunners({
      codex: [verdict("needs-user", "Which path should we use?")],
      claude: [verdict("needs-user", "Human still needs to decide")],
    });

    const output = await runParley({
      prompt1: "review",
      rounds: 1,
      first: "codex",
      sessions: {},
      runners,
    });

    expect(output.exitCode).toBe(3);
    expect(output.result.status).toBe("needs-user");
    expect(output.result.continuation).toBe(
      "parley --first codex --codex-session codex-session --claude-session claude-session '<your guidance / next prompt>' [<action>]",
    );
    expect(invocations[1]?.prompt).toContain("Open question:");
    expect(invocations[1]?.prompt).toContain("Which path should we use?");
  });

  it("deadlocks instead of settling when the reviewer question is only resolved by the actor", async () => {
    const { runners } = scriptedRunners({
      codex: [verdict("needs-user", "Need evidence")],
      claude: [verdict("agree", "Evidence is in the repo")],
    });

    const output = await runParley({
      prompt1: "review",
      rounds: 1,
      first: "codex",
      sessions: {},
      runners,
    });

    expect(output.exitCode).toBe(2);
    expect(output.result.status).toBe("deadlocked");
    expect(output.result.final.disagreement).toBe("needs-user reason");
  });

  it("uses --first to choose the reviewer slot", async () => {
    const { runners, invocations } = scriptedRunners({
      claude: [verdict("agree", "reviewer approves")],
      codex: [verdict("agree", "actor concurs")],
    });

    await runParley({
      prompt1: "review",
      rounds: 1,
      first: "claude",
      sessions: {},
      runners,
    });

    expect(invocations.map((invocation) => invocation.cli)).toEqual(["claude", "codex"]);
  });

  it("treats resumed prompt-1 as new guidance for resumed slots", async () => {
    const { runners, invocations } = scriptedRunners({
      codex: [verdict("agree")],
      claude: [verdict("agree")],
    });

    await runParley({
      prompt1: "new guidance",
      rounds: 1,
      first: "codex",
      sessions: {
        claude: "existing-claude",
        codex: "existing-codex",
      },
      runners,
    });

    expect(invocations[0]?.sessionId).toBe("existing-codex");
    expect(invocations[0]?.prompt).toContain("New guidance from the human:");
    expect(invocations[0]?.prompt).not.toContain("Task:");
    expect(invocations[1]?.sessionId).toBe("existing-claude");
    expect(invocations[1]?.prompt).toContain("New guidance from the human:");
  });

  it("returns failed without a continuation on invocation failure", async () => {
    const { runners } = scriptedRunners({
      codex: [],
      claude: [],
    });

    const output = await runParley({
      prompt1: "review",
      rounds: 1,
      first: "codex",
      sessions: {},
      runners,
    });

    expect(output.exitCode).toBe(4);
    expect(output.result.status).toBe("failed");
    expect(output.result.roundsExecuted).toBe(0);
    expect(output.result.final.summary).toBe("coding agent invocation failed");
    expect(output.result.continuation).toBeUndefined();
  });

  it("surfaces the failing actor error instead of a stale reviewer verdict", async () => {
    const { runners } = scriptedRunners({
      codex: [verdict("agree", "reviewer body")],
      claude: [],
    });

    const output = await runParley({
      prompt1: "review",
      rounds: 1,
      first: "codex",
      sessions: {},
      runners,
    });

    expect(output.exitCode).toBe(4);
    expect(output.result.final.summary).toBe("coding agent invocation failed");
    expect(output.result.final.result).toContain("no scripted verdict for claude");
    expect(output.result.final.result).not.toBe("reviewer body");
  });

  it("keeps a captured session id from failed invocations", async () => {
    const output = await runParley({
      prompt1: "review",
      rounds: 1,
      first: "codex",
      sessions: {},
      runners: {
        claude: {
          async run() {
            throw new Error("should not run");
          },
        },
        codex: {
          async run() {
            throw new CodingAgentInvocationError("codex", "out of credits", { sessionId: "captured-codex" });
          },
        },
      },
    });

    expect(output.exitCode).toBe(4);
    expect(output.result.sessions).toEqual({ codex: "captured-codex" });
    expect(output.result.continuation).toBeUndefined();
  });
});
