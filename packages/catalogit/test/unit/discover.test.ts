import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";

import { runDiscover, type DiscoverDeps, type DiscoverOptions } from "../../src/discover.js";
import { projectFileExists } from "../../src/project-writer.js";
import type { GhRepo, RunGh } from "../../src/github.js";
import type { RunProcess } from "../../src/coding-agent.js";
import type { RunGit } from "../../src/inspection-clone.js";

// ---------------------------------------------------------------------------
// Helpers / fakes
// ---------------------------------------------------------------------------

const DRAFT_STDOUT = "```markdown\n## What it does\nDoes stuff.\n```\n";

function makeRunProcess(): RunProcess {
  return async (_cmd, _args, _opts) => ({ code: 0, stdout: DRAFT_STDOUT, stderr: "" });
}

const runGhOk: RunGh = async (_args) => ({
  code: 0,
  stdout: JSON.stringify({ description: "desc", repositoryTopics: [] }),
  stderr: "",
});

const runGitOk: RunGit = async (_args) => ({ code: 0, stdout: "", stderr: "" });

function makeRepo(name: string, owner = "leanish"): GhRepo {
  return {
    name,
    owner,
    isArchived: false,
    isFork: false,
    url: `https://github.com/${owner}/${name}`,
    defaultBranch: "main",
    description: null,
    topics: [],
  };
}

const REPOS = [makeRepo("a"), makeRepo("b"), makeRepo("c")];

function fakeListRepos(_opts: unknown): Promise<readonly GhRepo[]> {
  return Promise.resolve(REPOS);
}

function makeSelect(toReturn: string[]): (choices: { name: string; value: string; checked?: boolean }[]) => Promise<string[]> {
  return async (_choices) => toReturn;
}

function makeOpts(overrides: Partial<DiscoverOptions> & { catalogRoot: string }): DiscoverOptions {
  const base: DiscoverOptions = {
    owner: "leanish",
    includeArchived: false,
    agent: "codex",
    force: false,
    skeleton: true, // default to skeleton:true for speed; specific tests override
    isTty: false,
    catalogRoot: overrides.catalogRoot,
  };
  return { ...base, ...overrides };
}

/** Capturing output sink — collects writes so tests can assert on emitted text. */
function captureSink(): { sink: { write(chunk: string): void }; text: () => string } {
  const chunks: string[] = [];
  return { sink: { write: (chunk) => void chunks.push(chunk) }, text: () => chunks.join("") };
}

function makeDeps(overrides: Partial<DiscoverDeps> = {}): DiscoverDeps {
  return {
    runProcess: makeRunProcess(),
    runGh: runGhOk,
    runGit: runGitOk,
    confirm: async (_msg) => true,
    listRepos: fakeListRepos,
    select: makeSelect([]),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runDiscover", () => {
  let catalogRoot: string;

  beforeEach(async () => {
    catalogRoot = await mkdtemp(join(tmpdir(), "catit-discover-"));
  });

  // -------------------------------------------------------------------------
  // --add with explicit names
  // -------------------------------------------------------------------------

  it("--add [a,c]: imports a and c, skips b; files written for a and c only", async () => {
    const result = await runDiscover(
      makeOpts({ catalogRoot, add: ["a", "c"], skeleton: true }),
      makeDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.summary.added.length + result.summary.skeleton.length).toBeGreaterThanOrEqual(2);

    expect(await projectFileExists(catalogRoot, "leanish/a")).toBe(true);
    expect(await projectFileExists(catalogRoot, "leanish/c")).toBe(true);
    expect(await projectFileExists(catalogRoot, "leanish/b")).toBe(false);
  });

  it("--add [a,c]: summary.skeleton contains leanish/a and leanish/c (skeleton=true)", async () => {
    const result = await runDiscover(
      makeOpts({ catalogRoot, add: ["a", "c"], skeleton: true }),
      makeDeps(),
    );

    expect(result.summary.skeleton).toContain("leanish/a");
    expect(result.summary.skeleton).toContain("leanish/c");
    expect(result.summary.skeleton).not.toContain("leanish/b");
  });

  it("routes the no-TTY error through the injected stderr sink (not a global)", async () => {
    const cap = captureSink();
    const result = await runDiscover(
      makeOpts({ catalogRoot }), // isTty:false default + no --add → no-TTY branch
      makeDeps({ stderr: cap.sink }),
    );
    expect(result.exitCode).toBe(1);
    expect(cap.text()).toContain("no TTY and no --add");
  });

  it("--add [a,c] case-insensitive: 'A' and 'C' match repos named a and c", async () => {
    await runDiscover(
      makeOpts({ catalogRoot, add: ["A", "C"], skeleton: true }),
      makeDeps(),
    );

    expect(await projectFileExists(catalogRoot, "leanish/a")).toBe(true);
    expect(await projectFileExists(catalogRoot, "leanish/c")).toBe(true);
    expect(await projectFileExists(catalogRoot, "leanish/b")).toBe(false);
  });

  it("--add with a name not in eligible repos → recorded in skipped with reason", async () => {
    const result = await runDiscover(
      makeOpts({ catalogRoot, add: ["a", "nonexistent"], skeleton: true }),
      makeDeps(),
    );

    expect(await projectFileExists(catalogRoot, "leanish/a")).toBe(true);
    const skipped = result.summary.skipped;
    const skippedRepos = skipped.map((s) => s.repo);
    expect(skippedRepos).toContain("nonexistent");
    const skippedEntry = skipped.find((s) => s.repo === "nonexistent");
    expect(skippedEntry?.reason).toBe("not found among eligible repos");
  });

  // -------------------------------------------------------------------------
  // --add ['*'] — import all
  // -------------------------------------------------------------------------

  it("--add ['*']: imports all three repos", async () => {
    const result = await runDiscover(
      makeOpts({ catalogRoot, add: ["*"], skeleton: true }),
      makeDeps(),
    );

    expect(result.exitCode).toBe(0);
    expect(await projectFileExists(catalogRoot, "leanish/a")).toBe(true);
    expect(await projectFileExists(catalogRoot, "leanish/b")).toBe(true);
    expect(await projectFileExists(catalogRoot, "leanish/c")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Interactive (isTty + no --add)
  // -------------------------------------------------------------------------

  it("interactive (isTty, no --add): select returns ['a'] → only leanish/a written", async () => {
    const result = await runDiscover(
      makeOpts({ catalogRoot, isTty: true, skeleton: true }),
      makeDeps({ select: makeSelect(["a"]) }),
    );

    expect(result.exitCode).toBe(0);
    expect(await projectFileExists(catalogRoot, "leanish/a")).toBe(true);
    expect(await projectFileExists(catalogRoot, "leanish/b")).toBe(false);
    expect(await projectFileExists(catalogRoot, "leanish/c")).toBe(false);
  });

  it("interactive: select receives a choice entry per repo", async () => {
    let capturedChoices: { name: string; value: string; checked?: boolean }[] = [];
    const spySelect = async (choices: typeof capturedChoices) => {
      capturedChoices = choices;
      return [];
    };

    await runDiscover(
      makeOpts({ catalogRoot, isTty: true, skeleton: true }),
      makeDeps({ select: spySelect }),
    );

    expect(capturedChoices.length).toBe(3);
    const values = capturedChoices.map((c) => c.value);
    expect(values).toContain("a");
    expect(values).toContain("b");
    expect(values).toContain("c");
  });

  // -------------------------------------------------------------------------
  // Repo with invalid slug → skipped, no file, runAdd not reached
  // -------------------------------------------------------------------------

  it("invalid-slug repo (.bad) in --add selection → skipped, no file written", async () => {
    const badRepo = makeRepo(".bad");
    const listReposWithBad = async (_opts: unknown): Promise<readonly GhRepo[]> =>
      [...REPOS, badRepo];

    const result = await runDiscover(
      makeOpts({ catalogRoot, add: ["a", ".bad"], skeleton: true }),
      makeDeps({ listRepos: listReposWithBad }),
    );

    // .bad has an invalid slug, so it should appear in skipped
    const skippedRepos = result.summary.skipped.map((s) => s.repo);
    expect(skippedRepos).toContain(".bad");
    // No file should be written for it
    // mapRepoToId("leanish", ".bad") should return ok:false
    // so we just check no leanish_ prefixed bad file
    expect(await projectFileExists(catalogRoot, "leanish/.bad")).toBe(false);
    // a should still be written
    expect(await projectFileExists(catalogRoot, "leanish/a")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Non-TTY + no --add → guidance + exitCode 1 + no files
  // -------------------------------------------------------------------------

  it("non-tty, no --add → exitCode 1, empty summary, no files written", async () => {
    const result = await runDiscover(
      makeOpts({ catalogRoot, isTty: false /* no add */ }),
      makeDeps(),
    );

    expect(result.exitCode).toBe(1);
    expect(result.summary.added).toEqual([]);
    expect(result.summary.overridden).toEqual([]);
    expect(result.summary.skeleton).toEqual([]);
    expect(result.summary.skipped).toEqual([]);
    expect(await projectFileExists(catalogRoot, "leanish/a")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Exit-code policy
  // -------------------------------------------------------------------------

  it("all selected already cataloged + force:false → all skipped → exitCode 1", async () => {
    // runAdd for existing + non-tty + no-force returns skipped/exitCode 1
    // We simulate this by having skeleton:false but a runProcess that fails so
    // the project already exists and force:false causes skip.
    // Actually the cleanest approach: pre-write all repos, then run without force.
    // existing + non-tty + !force → runAdd returns {status:"skipped", exitCode:1}
    const { writeProjectYaml } = await import("../../src/project-writer.js");
    await writeProjectYaml(catalogRoot, {
      id: "leanish/a",
      source: { url: "https://github.com/leanish/a.git", branch: "main" },
      extensions: {},
    });
    await writeProjectYaml(catalogRoot, {
      id: "leanish/b",
      source: { url: "https://github.com/leanish/b.git", branch: "main" },
      extensions: {},
    });

    const result = await runDiscover(
      makeOpts({ catalogRoot, add: ["a", "b"], skeleton: true, force: false, isTty: false }),
      makeDeps(),
    );

    // Both should be skipped (already cataloged, no force)
    expect(result.summary.skipped.length).toBeGreaterThanOrEqual(2);
    expect(result.exitCode).toBe(1);
  });

  it("one fresh repo + one already-cataloged: at least one written → exitCode 0", async () => {
    const { writeProjectYaml } = await import("../../src/project-writer.js");
    // pre-catalog only 'a'
    await writeProjectYaml(catalogRoot, {
      id: "leanish/a",
      source: { url: "https://github.com/leanish/a.git", branch: "main" },
      extensions: {},
    });

    const result = await runDiscover(
      makeOpts({ catalogRoot, add: ["a", "c"], skeleton: true, force: false, isTty: false }),
      makeDeps(),
    );

    // 'c' is fresh → should be written (skeleton)
    expect(await projectFileExists(catalogRoot, "leanish/c")).toBe(true);
    // At least one written → exitCode 0
    expect(result.exitCode).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Nothing selected (empty interactive pick) → exitCode 0
  // -------------------------------------------------------------------------

  it("interactive: nothing selected → exitCode 0, empty summary", async () => {
    const result = await runDiscover(
      makeOpts({ catalogRoot, isTty: true, skeleton: true }),
      makeDeps({ select: makeSelect([]) }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.summary.added).toEqual([]);
    expect(result.summary.skeleton).toEqual([]);
  });
});
