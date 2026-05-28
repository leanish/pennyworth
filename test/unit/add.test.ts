import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";

import { runAdd, type AddDeps, type AddOptions } from "../../src/add.js";
import { writeProjectYaml, projectFileExists } from "../../src/project-writer.js";
import { FilesystemCatalog } from "../../src/filesystem-catalog.js";
import type { RunProcess } from "../../src/coding-agent.js";
import type { RunGh } from "../../src/github.js";
import type { RunGit } from "../../src/inspection-clone.js";

// ---------------------------------------------------------------------------
// Fake deps
// ---------------------------------------------------------------------------

const DRAFT_STDOUT = "```markdown\n## What it does\nDoes stuff.\n```\n";

function makeRunProcess(code: number = 0): RunProcess {
  return async (_cmd, _args, _opts) => ({
    code,
    stdout: code === 0 ? DRAFT_STDOUT : "",
    stderr: code !== 0 ? "agent failed" : "",
  });
}

const runGhOk: RunGh = async (_args) => ({
  code: 0,
  stdout: JSON.stringify({ description: "A test repo", repositoryTopics: [] }),
  stderr: "",
});

const runGitOk: RunGit = async (_args) => ({ code: 0, stdout: "", stderr: "" });

function confirmFn(answer: boolean): (msg: string) => Promise<boolean> {
  return async (_msg) => answer;
}

function makeOpts(
  overrides: Partial<AddOptions> & { catalogRoot: string },
): AddOptions {
  const base: AddOptions = {
    id: "leanish/foo",
    agent: "codex",
    force: false,
    skeleton: false,
    isTty: false,
    catalogRoot: overrides.catalogRoot,
  };
  return { ...base, ...overrides };
}

function makeDeps(overrides: Partial<AddDeps> = {}): AddDeps {
  return {
    runProcess: makeRunProcess(0),
    runGh: runGhOk,
    runGit: runGitOk,
    confirm: confirmFn(true),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAdd", () => {
  let catalogRoot: string;

  beforeEach(async () => {
    catalogRoot = await mkdtemp(join(tmpdir(), "catit-add-"));
  });

  // --- happy path -----------------------------------------------------------

  it("happy add: fresh id, llm drafts → file written, status added, exitCode 0", async () => {
    const result = await runAdd(
      makeOpts({ catalogRoot }),
      makeDeps(),
    );

    expect(result).toEqual({ status: "added", exitCode: 0 });
    expect(await projectFileExists(catalogRoot, "leanish/foo")).toBe(true);

    const catalog = await FilesystemCatalog.load({ catalogRoot });
    const project = catalog.get("leanish/foo");
    expect(project?.description).toBe("## What it does\nDoes stuff.");
    expect(project?.source.url).toBe("https://github.com/leanish/foo.git");
    expect(project?.source.branch).toBe("main");
  });

  // --- --skeleton -------------------------------------------------------------

  it("--skeleton: writes skeleton, status skeleton, exitCode 0", async () => {
    const result = await runAdd(
      makeOpts({ catalogRoot, skeleton: true }),
      makeDeps(),
    );

    expect(result).toEqual({ status: "skeleton", exitCode: 0 });
    expect(await projectFileExists(catalogRoot, "leanish/foo")).toBe(true);

    const catalog = await FilesystemCatalog.load({ catalogRoot });
    const project = catalog.get("leanish/foo");
    expect(project?.description).toBeUndefined();
  });

  // --- existing + force: spine preserved ------------------------------------

  it("existing + force: re-drafts, preserves extensions, status overridden", async () => {
    // Pre-write a record with custom extensions
    await writeProjectYaml(catalogRoot, {
      id: "leanish/foo",
      source: { url: "https://github.com/leanish/foo.git", branch: "main" },
      description: "old description",
      extensions: { atc: { enabled: false } },
    });

    const result = await runAdd(
      makeOpts({ catalogRoot, force: true }),
      makeDeps(),
    );

    expect(result).toEqual({ status: "overridden", exitCode: 0 });

    const catalog = await FilesystemCatalog.load({ catalogRoot });
    const project = catalog.get("leanish/foo");
    // Description should have changed
    expect(project?.description).toBe("## What it does\nDoes stuff.");
    // Extensions must be preserved verbatim
    expect(project?.extensions).toEqual({ atc: { enabled: false } });
  });

  // --- existing + force + --skeleton: spine preserved, description dropped -----

  it("existing + force + --skeleton: preserves extensions, drops description, status overridden", async () => {
    await writeProjectYaml(catalogRoot, {
      id: "leanish/foo",
      source: { url: "https://github.com/leanish/foo.git", branch: "main" },
      description: "old description",
      extensions: { atc: { enabled: false } },
    });

    const result = await runAdd(
      makeOpts({ catalogRoot, force: true, skeleton: true }),
      makeDeps(),
    );

    expect(result).toEqual({ status: "overridden", exitCode: 0 });

    const catalog = await FilesystemCatalog.load({ catalogRoot });
    const project = catalog.get("leanish/foo");
    expect(project?.description).toBeUndefined();
    expect(project?.extensions).toEqual({ atc: { enabled: false } });
  });

  // --- existing, no force, isTty:false → skipped ----------------------------

  it("existing, no force, isTty:false → skipped, exitCode 1, file unchanged", async () => {
    await writeProjectYaml(catalogRoot, {
      id: "leanish/foo",
      source: { url: "https://github.com/leanish/foo.git", branch: "main" },
      description: "original",
      extensions: {},
    });

    const result = await runAdd(
      makeOpts({ catalogRoot, isTty: false }),
      makeDeps(),
    );

    expect(result).toEqual({ status: "skipped", exitCode: 1 });

    const catalog = await FilesystemCatalog.load({ catalogRoot });
    expect(catalog.get("leanish/foo")?.description).toBe("original");
  });

  // --- existing, no force, isTty:true, confirm→true -------------------------

  it("existing, no force, isTty:true, confirm→true → overridden", async () => {
    await writeProjectYaml(catalogRoot, {
      id: "leanish/foo",
      source: { url: "https://github.com/leanish/foo.git", branch: "main" },
      description: "original",
      extensions: {},
    });

    const result = await runAdd(
      makeOpts({ catalogRoot, isTty: true }),
      makeDeps({ confirm: confirmFn(true) }),
    );

    expect(result.status).toBe("overridden");
    expect(result.exitCode).toBe(0);
  });

  // --- existing, no force, isTty:true, confirm→false ------------------------

  it("existing, no force, isTty:true, confirm→false → skipped, exitCode 0", async () => {
    await writeProjectYaml(catalogRoot, {
      id: "leanish/foo",
      source: { url: "https://github.com/leanish/foo.git", branch: "main" },
      description: "original",
      extensions: {},
    });

    const result = await runAdd(
      makeOpts({ catalogRoot, isTty: true }),
      makeDeps({ confirm: confirmFn(false) }),
    );

    expect(result).toEqual({ status: "skipped", exitCode: 0 });
  });

  // --- draft fails twice → skeleton, exitCode 4 -----------------------------

  it("draft fails twice → skeleton, exitCode 4", async () => {
    const result = await runAdd(
      makeOpts({ catalogRoot }),
      makeDeps({ runProcess: makeRunProcess(1) }),
    );

    expect(result).toEqual({ status: "skeleton", exitCode: 4 });
    expect(await projectFileExists(catalogRoot, "leanish/foo")).toBe(true);

    // Should be skeleton (no description)
    const catalog = await FilesystemCatalog.load({ catalogRoot });
    const project = catalog.get("leanish/foo");
    expect(project?.description).toBeUndefined();
  });

  // --- invalid id -----------------------------------------------------------

  it("invalid owner (Bad_Owner/x) → skipped, exitCode 1", async () => {
    const result = await runAdd(
      makeOpts({ catalogRoot, id: "Bad_Owner/x" }),
      makeDeps(),
    );

    expect(result).toEqual({ status: "skipped", exitCode: 1 });
  });

  it("invalid slug (owner/Bad-Slug!) → skipped, exitCode 1", async () => {
    const result = await runAdd(
      makeOpts({ catalogRoot, id: "leanish/Bad-Slug!" }),
      makeDeps(),
    );

    expect(result).toEqual({ status: "skipped", exitCode: 1 });
  });

  // --- fromGithub populates githubMeta in prompt ----------------------------

  it("fromGithub: calls getRepoMeta and passes context to agent", async () => {
    let capturedArgs: readonly string[] | undefined;
    const spyGh: RunGh = async (args) => {
      capturedArgs = args;
      return {
        code: 0,
        stdout: JSON.stringify({
          description: "GH description",
          repositoryTopics: [{ name: "typescript" }],
        }),
        stderr: "",
      };
    };

    await runAdd(
      makeOpts({ catalogRoot, fromGithub: "leanish/foo" }),
      makeDeps({ runGh: spyGh }),
    );

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs).toContain("view");
    expect(capturedArgs).toContain("leanish/foo");
  });
});
