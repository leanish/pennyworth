import { describe, it, expect } from "vitest";
import { listRepos, getRepoMeta, GhError } from "../../src/github.js";

const fixture = JSON.stringify([
  { name: "a", owner: { login: "leanish" }, isArchived: false, isFork: false, url: "https://github.com/leanish/a", defaultBranchRef: { name: "main" }, description: "d", repositoryTopics: [] },
  { name: "b", owner: { login: "leanish" }, isArchived: true,  isFork: false, url: "https://github.com/leanish/b", defaultBranchRef: { name: "main" }, description: null, repositoryTopics: [] },
  { name: "c", owner: { login: "leanish" }, isArchived: false, isFork: true,  url: "https://github.com/leanish/c", defaultBranchRef: { name: "dev" }, description: "f", repositoryTopics: [] },
]);

describe("listRepos", () => {
  it("parses gh JSON, excludes archived by default, keeps forks", async () => {
    const runGh = async () => ({ code: 0, stdout: fixture, stderr: "" });
    const repos = await listRepos({ owner: "leanish", includeArchived: false, runGh });
    expect(repos.map(r => r.name)).toEqual(["a", "c"]); // b archived dropped, c fork kept
    expect(repos[0]).toMatchObject({ name: "a", owner: "leanish", defaultBranch: "main", description: "d" });
  });
  it("includeArchived keeps archived too", async () => {
    const runGh = async () => ({ code: 0, stdout: fixture, stderr: "" });
    const repos = await listRepos({ owner: "leanish", includeArchived: true, runGh });
    expect(repos.map(r => r.name)).toEqual(["a", "b", "c"]);
  });
  it("omits the owner arg when owner is undefined (authed user)", async () => {
    let seen: readonly string[] = [];
    const runGh = async (args: readonly string[]) => { seen = args; return { code: 0, stdout: "[]", stderr: "" }; };
    await listRepos({ includeArchived: false, runGh });
    expect(seen).toContain("list");
    expect(seen).not.toContain(undefined as unknown as string);
  });
  it("throws GhError when gh exits non-zero (missing/unauth)", async () => {
    const runGh = async () => ({ code: 127, stdout: "", stderr: "command not found: gh" });
    await expect(listRepos({ owner: "x", includeArchived: false, runGh })).rejects.toBeInstanceOf(GhError);
  });
  it("normalizes null repositoryTopics (gh emits null for topic-less repos) to []", async () => {
    const entry = JSON.stringify([
      { name: "a", owner: { login: "leanish" }, isArchived: false, isFork: false, url: "https://github.com/leanish/a", defaultBranchRef: { name: "main" }, description: null, repositoryTopics: null },
    ]);
    const runGh = async () => ({ code: 0, stdout: entry, stderr: "" });
    const repos = await listRepos({ owner: "leanish", includeArchived: false, runGh });
    expect(repos[0]?.topics).toEqual([]);
  });
});

describe("getRepoMeta", () => {
  it("returns description + topics", async () => {
    const runGh = async () => ({ code: 0, stdout: JSON.stringify({ description: "D", repositoryTopics: [{ name: "t1" }] }), stderr: "" });
    const meta = await getRepoMeta({ owner: "leanish", repo: "a", runGh });
    expect(meta).toEqual({ description: "D", topics: ["t1"] });
  });
  it("normalizes null repositoryTopics to []", async () => {
    const runGh = async () => ({ code: 0, stdout: JSON.stringify({ description: null, repositoryTopics: null }), stderr: "" });
    const meta = await getRepoMeta({ owner: "leanish", repo: "a", runGh });
    expect(meta).toEqual({ description: null, topics: [] });
  });
});
