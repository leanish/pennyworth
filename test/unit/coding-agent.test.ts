import { describe, it, expect } from "vitest";
import { extractFencedMarkdown, resolveCodingAgent, draftDescription, DraftError } from "../../src/coding-agent.js";

describe("extractFencedMarkdown", () => {
  it("extracts the last ```markdown fenced block", () => {
    expect(extractFencedMarkdown("Sure:\n\n```markdown\n## What it does\n...\n```\n")).toBe("## What it does\n...");
  });
  it("returns null when no fenced block is present", () => {
    expect(extractFencedMarkdown("no fence here")).toBeNull();
  });
});

describe("resolveCodingAgent", () => {
  it("flag > env > default codex", () => {
    expect(resolveCodingAgent(undefined, {})).toBe("codex");
    expect(resolveCodingAgent(undefined, { CATALOGIT_CODING_AGENT: "claude" })).toBe("claude");
    expect(resolveCodingAgent("claude", { CATALOGIT_CODING_AGENT: "codex" })).toBe("claude");
  });
  it("throws on an unknown agent", () => {
    expect(() => resolveCodingAgent("gpt", {})).toThrow(/unknown coding agent/i);
  });
});

describe("draftDescription", () => {
  it("spawns codex exec with cwd and returns the fenced block", async () => {
    const calls: { cmd: string; args: readonly string[]; cwd: string | undefined }[] = [];
    const runProcess = async (cmd: string, args: readonly string[], opts: { cwd?: string; input?: string }) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { code: 0, stdout: "```markdown\nhi\n```", stderr: "" };
    };
    const desc = await draftDescription({ agent: "codex", cwd: "/clone", prompt: "P", runProcess });
    expect(desc).toBe("hi");
    expect(calls[0]).toEqual({ cmd: "codex", args: ["exec", "P"], cwd: "/clone" });
  });
  it("uses claude -p for the claude agent", async () => {
    let seen: readonly string[] = [];
    const rp = async (_c: string, a: readonly string[]) => {
      seen = a;
      return { code: 0, stdout: "```markdown\nx\n```", stderr: "" };
    };
    await draftDescription({ agent: "claude", cwd: "/c", prompt: "P", runProcess: rp });
    expect(seen).toEqual(["-p", "P"]);
  });
  it("throws DraftError on non-zero exit", async () => {
    const runProcess = async () => ({ code: 1, stdout: "", stderr: "boom" });
    await expect(draftDescription({ agent: "codex", cwd: "/c", prompt: "P", runProcess })).rejects.toBeInstanceOf(DraftError);
  });
  it("throws DraftError when no fenced block in output", async () => {
    const runProcess = async () => ({ code: 0, stdout: "chatter only", stderr: "" });
    await expect(draftDescription({ agent: "codex", cwd: "/c", prompt: "P", runProcess })).rejects.toBeInstanceOf(DraftError);
  });
});
