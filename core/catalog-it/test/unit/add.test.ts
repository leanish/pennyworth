import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { runAdd, type AddDeps, type AddOptions } from "../../src/add.js";
import { writeProjectYaml, projectFileExists } from "../../src/project-writer.js";
import { FilesystemCatalog } from "../../src/filesystem-catalog.js";
import { validateCatalog } from "../../src/validate.js";
import type { RunProcess, RunResult } from "../../src/coding-agent.js";
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

/** Capturing output sink — collects writes so tests can assert on emitted text. */
function captureSink(): { sink: { write(chunk: string): void }; text: () => string } {
  const chunks: string[] = [];
  return { sink: { write: (chunk) => void chunks.push(chunk) }, text: () => chunks.join("") };
}

function makeDeps(overrides: Partial<AddDeps> = {}): AddDeps {
  return {
    runProcess: makeRunProcess(0),
    runGh: runGhOk,
    runGit: runGitOk,
    confirm: confirmFn(true),
    stderr: { write: () => {} },
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

  it("fresh add records the repo's REAL default branch (master), not a hardcoded main", async () => {
    const runGh: RunGh = async (_args) => ({
      code: 0,
      stdout: JSON.stringify({
        description: "legacy repo",
        repositoryTopics: [],
        defaultBranchRef: { name: "master" },
      }),
      stderr: "",
    });
    const result = await runAdd(makeOpts({ catalogRoot }), makeDeps({ runGh }));

    expect(result).toEqual({ status: "added", exitCode: 0 });
    const catalog = await FilesystemCatalog.load({ catalogRoot });
    expect(catalog.get("leanish/foo")?.source.branch).toBe("master");
  });

  it("fresh add falls back to main with a warning when gh can't resolve the branch", async () => {
    const runGh: RunGh = async (_args) => ({ code: 1, stdout: "", stderr: "gh: not logged in" });
    const { sink, text } = captureSink();
    const result = await runAdd(makeOpts({ catalogRoot }), makeDeps({ runGh, stderr: sink }));

    expect(result).toEqual({ status: "added", exitCode: 0 });
    const catalog = await FilesystemCatalog.load({ catalogRoot });
    expect(catalog.get("leanish/foo")?.source.branch).toBe("main");
    expect(text()).toContain('could not resolve the default branch for "leanish/foo"');
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

  it("mixed-case add input yields a lowercase id AND filename that validate cleanly", async () => {
    // Regression: id and filename must normalize together — a mixed-case
    // filename with a lowercased record id fails the catalog's own
    // filename⇄id validation.
    const result = await runAdd(
      makeOpts({ catalogRoot, id: "Acme/Widget-Lib" }),
      makeDeps(),
    );

    expect(result).toEqual({ status: "added", exitCode: 0 });
    expect(await readdir(join(catalogRoot, "projects"))).toEqual(["acme_widget-lib.yaml"]);

    const validation = await validateCatalog({ catalogRoot });
    expect(validation.issues).toEqual([]);

    const catalog = await FilesystemCatalog.load({ catalogRoot });
    expect(catalog.get("acme/widget-lib")?.id).toBe("acme/widget-lib");
    expect(catalog.get("acme/widget-lib")?.source.url).toBe(
      "https://github.com/acme/widget-lib.git",
    );
  });

  it("routes error output through the injected stderr sink (not a global)", async () => {
    const cap = captureSink();
    const result = await runAdd(
      makeOpts({ catalogRoot, id: "Bad Owner/repo" }),
      makeDeps({ stderr: cap.sink }),
    );
    expect(result).toEqual({ status: "skipped", exitCode: 1 });
    expect(cap.text()).toContain(`invalid id "Bad Owner/repo"`);
  });

  it("announces drafting on stderr (drafting is minutes-long with no output of its own)", async () => {
    const cap = captureSink();
    await runAdd(makeOpts({ catalogRoot }), makeDeps({ stderr: cap.sink }));
    expect(cap.text()).toContain(`drafting "leanish/foo" via`);
  });

  it("reports completion with elapsed time after a successful draft", async () => {
    const cap = captureSink();
    await runAdd(makeOpts({ catalogRoot }), makeDeps({ stderr: cap.sink }));
    expect(cap.text()).toMatch(/drafted "leanish\/foo" in \d+s/);
  });

  it("emits still-drafting heartbeats while the agent runs", async () => {
    // Fake only the heartbeat's interval + clock; real timers keep driving the
    // fs/promise machinery runAdd awaits before the draft starts.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      let release!: (r: RunResult) => void;
      const gate = new Promise<RunResult>((resolve) => (release = resolve));
      const cap = captureSink();
      const pending = runAdd(
        makeOpts({ catalogRoot }),
        makeDeps({ stderr: cap.sink, runProcess: () => gate }),
      );
      // Wait (real time) until runAdd reaches the draft and starts the heartbeat.
      while (!cap.text().includes("drafting")) {
        await new Promise((r) => setTimeout(r, 1));
      }
      await vi.advanceTimersByTimeAsync(65_000);
      expect(cap.text()).toContain(`still drafting "leanish/foo"`);
      expect(cap.text()).toContain("s elapsed");
      release({ code: 0, stdout: DRAFT_STDOUT, stderr: "" });
      await pending;
      // Heartbeat stops after completion: no further ticks accumulate.
      const after = cap.text();
      await vi.advanceTimersByTimeAsync(65_000);
      expect(cap.text()).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("--skeleton stays silent on stderr (no drafting happens)", async () => {
    const cap = captureSink();
    await runAdd(makeOpts({ catalogRoot, skeleton: true }), makeDeps({ stderr: cap.sink }));
    expect(cap.text()).toBe("");
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

  it("fromGithub: source.branch comes from the SOURCE repo, never the --from-github metadata repo", async () => {
    // Regression: --from-github fetches description/topics from a DIFFERENT
    // repo; its default branch must not leak into the source spine.
    const runGh: RunGh = async (args) => {
      const target = args.find((a) => a.includes("/")) ?? "";
      if (target === "upstream/bar") {
        // the metadata repo — different default branch on purpose
        return {
          code: 0,
          stdout: JSON.stringify({
            description: "from upstream",
            repositoryTopics: [],
            defaultBranchRef: { name: "trunk" },
          }),
          stderr: "",
        };
      }
      // the source repo (leanish/foo)
      return {
        code: 0,
        stdout: JSON.stringify({ description: "src", repositoryTopics: [], defaultBranchRef: { name: "master" } }),
        stderr: "",
      };
    };

    await runAdd(
      makeOpts({ catalogRoot, fromGithub: "upstream/bar" }),
      makeDeps({ runGh }),
    );

    const catalog = await FilesystemCatalog.load({ catalogRoot });
    const project = catalog.get("leanish/foo");
    expect(project?.source.url).toBe("https://github.com/leanish/foo.git");
    expect(project?.source.branch).toBe("master"); // source, not "trunk"
  });
});
