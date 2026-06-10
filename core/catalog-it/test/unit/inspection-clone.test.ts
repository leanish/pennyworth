import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { withInspectionClone } from "../../src/inspection-clone.js";

describe("withInspectionClone", () => {
  it("shallow-clones, runs the body with the dir, cleans up after success", async () => {
    let seenDir = ""; const calls: string[][] = [];
    const runGit = async (args: readonly string[]) => { calls.push([...args]); return { code: 0, stdout: "", stderr: "" }; };
    const result = await withInspectionClone({ url: "https://github.com/leanish/foo.git", runGit }, async (dir) => { seenDir = dir; expect(existsSync(dir)).toBe(true); return "ok"; });
    expect(result).toBe("ok");
    expect(calls[0]).toEqual(expect.arrayContaining(["clone", "--depth", "1", "--single-branch"]));
    expect(existsSync(seenDir)).toBe(false);
  });
  it("cleans up even when the body throws, and rethrows", async () => {
    let seenDir = "";
    const runGit = async () => ({ code: 0, stdout: "", stderr: "" });
    await expect(withInspectionClone({ url: "u", runGit }, async (dir) => { seenDir = dir; throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(seenDir)).toBe(false);
  });
  it("passes --branch when provided", async () => {
    let seen: string[] = [];
    const runGit = async (args: readonly string[]) => { seen = [...args]; return { code: 0, stdout: "", stderr: "" }; };
    await withInspectionClone({ url: "u", branch: "dev", runGit }, async () => "x");
    expect(seen).toEqual(expect.arrayContaining(["--branch", "dev"]));
  });
});
