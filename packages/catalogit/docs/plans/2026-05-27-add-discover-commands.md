# catalogit `add` + `discover` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Commits:** This repo's owner commits manually. Do **NOT** run `git commit` during execution. Where a task says "checkpoint", just stop for review — leave staging/committing to the user.

**Goal:** Add two curation commands to the `catalogit` CLI — `add <id>` (add/override one project, description drafted by a coding agent) and `discover` (list a GitHub owner's repos, multi-select, import each via the `add` flow).

**Architecture:** Flat modules under `src/`, matching the existing layout. The two commands share infrastructure: a `gh api` wrapper, a one-shot coding-agent invoker, an inspection-clone manager, a drafting-prompt builder, a per-project YAML writer, and a GitHub-repo→catalog-id mapper. Every module that touches a subprocess, the network, or the filesystem takes an **injectable runner seam** (`runProcess` / `runGh` / `runGit` / a `confirm`/`select` prompt fn) so unit tests stay binary-free and Docker-free — exactly how the existing `s3-catalog` tests inject a fake client. The real seams (spawning `gh`/`codex`/`claude`/`git`, `@inquirer/prompts` checkbox) are wired only in `cli.ts`.

**Tech Stack:** Node 24 (ESM), TypeScript strict, `yaml` (eemeli/yaml), `node:child_process` (subprocess seams), `node:util.parseArgs`, `@inquirer/prompts` (new — `checkbox`/`confirm`), Vitest. Per catalogit ADR-0006 and `specs/.../cli.md`.

**Spec sources (read-only references):**
- `../../../specs/agentic-development/catalogit/specs/cli.md` — `add`, `discover`, drafting prompt, flags, error model.
- `../../../specs/agentic-development/catalogit/specs/data-format.md` — spine + slug patterns, filename rule.
- `../../../specs/agentic-development/catalogit/docs/adr/0006-tech-stack.md` — deps + the gh-shell-out / own-invoker / prompt-lib decisions.

---

## File structure

| File | Responsibility |
|---|---|
| `src/repo-id.ts` (create) | Pure: GitHub `owner/repo` → `{ id, owner, slug, filename }` lowercase-normalized, or a skip reason if the normalized name can't satisfy the slug pattern. |
| `src/project-writer.ts` (create) | Write a `Project` (or a spine-only skeleton) to `<catalogRoot>/projects/<owner>_<slug>.yaml` via `yaml`. Detect "already cataloged" (file exists). |
| `src/coding-agent.ts` (create) | `resolveCodingAgent(flag, env)` (default `codex`); `extractFencedMarkdown(stdout)` (pure); `draftDescription({ agent, cwd, prompt, runProcess })` → description text, mapping failures to a typed `DraftError`. |
| `src/drafting-prompt.ts` (create) | `buildDraftingPrompt({ id, githubMeta? })` → the prompt string (conventions + worked example + terminal-fenced-`markdown` instruction). |
| `src/github.ts` (create) | `listRepos({ owner?, includeArchived, runGh })`, `getRepoMeta({ owner, repo, runGh })`. Shell out to `gh api` (paginated), parse JSON, map missing/unauth `gh` → typed `GhError`. |
| `src/inspection-clone.ts` (create) | `withInspectionClone({ url, branch?, runGit }, fn)` → shallow-clone to a scratch dir, `await fn(dir)`, delete in `finally`. |
| `src/add.ts` (create) | `runAdd(opts)` — orchestrates the single-project flow (id check + `--force`/confirm, materialize source, draft, validate spine, write/override, cleanup). Returns a typed result + exit code. |
| `src/discover.ts` (create) | `runDiscover(opts)` — gh list → eligibility filter → selection (`select` seam or `--add`) → per-repo `runAdd` flow → summary. |
| `src/cli.ts` (modify) | Route `add` / `discover`; `parseArgs` flags; wire the **real** seams (`child_process` spawns, `@inquirer/prompts`). Extend `USAGE`. |
| `package.json` (modify) | Add `@inquirer/prompts` to `dependencies`. |
| `test/unit/*.test.ts` (create per module) | Vitest, fakes for every seam. |

**Shared types** (define in `src/coding-agent.ts` / `src/github.ts` and import elsewhere — do not redefine):
```ts
export type CodingAgent = "codex" | "claude";
export interface RunResult { readonly code: number; readonly stdout: string; readonly stderr: string; }
export type RunProcess = (cmd: string, args: readonly string[], opts: { cwd?: string; input?: string }) => Promise<RunResult>;
// github.ts
export interface GhRepo { readonly nameWithOwner: string; readonly name: string; readonly owner: string; readonly isArchived: boolean; readonly isFork: boolean; readonly url: string; readonly defaultBranch: string; readonly description: string | null; readonly topics: readonly string[]; }
export type RunGh = (args: readonly string[]) => Promise<RunResult>;
```

---

## Task 1: `repo-id.ts` — GitHub repo → catalog id mapping

**Files:** Create `src/repo-id.ts`; Test `test/unit/repo-id.test.ts`.

The slug rules (data-format.md): owner `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, slug `^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$`. Map by lowercasing; if either part fails its pattern after lowercasing, return a skip.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from "vitest";
import { mapRepoToId } from "../../src/repo-id.js";

describe("mapRepoToId", () => {
  it("lowercase-normalizes owner/repo into id + filename", () => {
    expect(mapRepoToId("Leanish", "Agent-ATC")).toEqual({
      ok: true, id: "leanish/agent-atc", owner: "leanish", slug: "agent-atc",
      filename: "leanish_agent-atc.yaml",
    });
  });
  it("preserves slug-legal punctuation (_ . -)", () => {
    expect(mapRepoToId("leanish", "my_repo.v2").id).toBe("leanish/my_repo.v2");
  });
  it("skips a name that can't satisfy the slug pattern", () => {
    expect(mapRepoToId("leanish", ".github")).toEqual({ ok: false, reason: expect.stringContaining("slug") });
  });
});
```
- [ ] **Step 2: Run, verify fail** — `npx vitest run test/unit/repo-id.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — export `type MapResult = { ok: true; id: string; owner: string; slug: string; filename: string } | { ok: false; reason: string }`. Lowercase both; test against the two regexes (hoist as consts); on success build `id = `${owner}/${slug}``, `filename = `${owner}_${slug}.yaml``; on failure return `{ ok:false, reason }` naming which part failed.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Checkpoint.**

---

## Task 2: `project-writer.ts` — per-project YAML writer + skeleton

**Files:** Create `src/project-writer.ts`; Test `test/unit/project-writer.test.ts`. Reuse the `Project` type from `src/project.ts`.

- [ ] **Step 1: Failing test** (write to a `mkdtemp` dir; read the file back and re-parse with `FilesystemCatalog` to prove round-trip + spine validity):
```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { writeProjectYaml, writeSkeleton, projectFileExists } from "../../src/project-writer.js";

it("writes a full project record to projects/<owner>_<slug>.yaml", async () => {
  const root = await mkdtemp(join(tmpdir(), "catit-"));
  await writeProjectYaml(root, { id: "leanish/foo", source: { url: "https://github.com/leanish/foo.git", branch: "main" }, description: "hi", extensions: {} });
  const text = await readFile(join(root, "projects", "leanish_foo.yaml"), "utf8");
  expect(text).toContain("id: leanish/foo");
  expect(await projectFileExists(root, "leanish/foo")).toBe(true);
});

it("writeSkeleton omits branch/extensions/description", async () => {
  const root = await mkdtemp(join(tmpdir(), "catit-"));
  await writeSkeleton(root, "leanish/bar", "https://github.com/leanish/bar.git");
  const text = await readFile(join(root, "projects", "leanish_bar.yaml"), "utf8");
  expect(text).toContain("url: https://github.com/leanish/bar.git");
  expect(text).not.toContain("branch:");
  expect(text).not.toContain("extensions");
});
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `mkdir(projects, {recursive:true})`; serialize with `yaml.stringify` honoring the spine key order (`id`, `source`, `extensions`, `description`); `writeProjectYaml` writes the full record; `writeSkeleton` writes only `{ id, source: { url } }`; `projectFileExists(root, id)` maps id→filename (split on first `/`, join with `_`) and `fs.access`-checks. Derive the filename via `mapRepoToId`-style join (or import a small `idToFilename` helper — define it here and have `repo-id.ts` reuse it to avoid drift).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Checkpoint.**

---

## Task 3: `coding-agent.ts` part 1 — `extractFencedMarkdown` (pure)

**Files:** Create `src/coding-agent.ts`; Test `test/unit/coding-agent.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from "vitest";
import { extractFencedMarkdown } from "../../src/coding-agent.js";

it("extracts the last ```markdown fenced block", () => {
  const out = "Sure, here it is:\n\n```markdown\n## What it does\n...\n```\n";
  expect(extractFencedMarkdown(out)).toBe("## What it does\n...");
});
it("returns null when no fenced block is present", () => {
  expect(extractFencedMarkdown("no fence here")).toBeNull();
});
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — regex match all ```` ```markdown ... ``` ```` blocks (also accept bare ```` ``` ```` as a fallback), return the trimmed body of the **last** match, else `null`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Checkpoint.**

---

## Task 4: `coding-agent.ts` part 2 — `resolveCodingAgent` + `draftDescription`

**Files:** Modify `src/coding-agent.ts`; extend `test/unit/coding-agent.test.ts`. Uses the `RunProcess` seam.

- [ ] **Step 1: Failing tests**
```ts
import { resolveCodingAgent, draftDescription } from "../../src/coding-agent.js";

it("resolveCodingAgent: flag > env > default codex", () => {
  expect(resolveCodingAgent(undefined, {})).toBe("codex");
  expect(resolveCodingAgent(undefined, { CATALOGIT_CODING_AGENT: "claude" })).toBe("claude");
  expect(resolveCodingAgent("claude", { CATALOGIT_CODING_AGENT: "codex" })).toBe("claude");
  expect(() => resolveCodingAgent("gpt", {})).toThrow(/unknown coding agent/);
});

it("draftDescription spawns codex exec and returns the fenced block", async () => {
  const calls: string[][] = [];
  const runProcess = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: "```markdown\nhi\n```", stderr: "" }; };
  const desc = await draftDescription({ agent: "codex", cwd: "/clone", prompt: "P", runProcess });
  expect(desc).toBe("hi");
  expect(calls[0][0]).toBe("codex");
});

it("draftDescription throws DraftError when no fenced block", async () => {
  const runProcess = async () => ({ code: 0, stdout: "chatter only", stderr: "" });
  await expect(draftDescription({ agent: "codex", cwd: "/c", prompt: "P", runProcess })).rejects.toThrow(/DraftError|no .*block/i);
});
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `resolveCodingAgent` validates against `["codex","claude"]`. `draftDescription` builds argv per agent (`codex` → `["exec", prompt]`; `claude` → `["-p", prompt]`), calls `runProcess(agent, argv, { cwd })`, on non-zero `code` throws `DraftError` (include stderr tail), else `extractFencedMarkdown(stdout)` → throw `DraftError` if null. Export `class DraftError extends Error`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Checkpoint.**

---

## Task 5: `drafting-prompt.ts`

**Files:** Create `src/drafting-prompt.ts`; Test `test/unit/drafting-prompt.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { buildDraftingPrompt } from "../../src/drafting-prompt.js";
it("includes the id, the section conventions, and the fenced-block instruction", () => {
  const p = buildDraftingPrompt({ id: "leanish/foo" });
  expect(p).toContain("leanish/foo");
  expect(p).toMatch(/what this agent does/i);
  expect(p).toMatch(/```markdown/);
});
it("includes GitHub metadata when provided", () => {
  expect(buildDraftingPrompt({ id: "leanish/foo", githubMeta: { description: "D", topics: ["t1"] } })).toContain("D");
});
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — a template string with: the canonical id, suggested sections ("what this agent does", "stack", "notes for routing", "owners", "workflows"), a worked example, optional GitHub description/topics, and an explicit "end your response with a single ```markdown fenced block containing only the description" instruction.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Checkpoint.**

---

## Task 6: `github.ts` — `gh api` wrapper

**Files:** Create `src/github.ts`; Test `test/unit/github.test.ts`. Uses the `RunGh` seam.

- [ ] **Step 1: Failing tests**
```ts
import { listRepos, getRepoMeta, GhError } from "../../src/github.js";

it("listRepos parses gh JSON and filters archived by default", async () => {
  const runGh = async () => ({ code: 0, stderr: "",
    stdout: JSON.stringify([
      { name: "a", owner: { login: "leanish" }, isArchived: false, isFork: false, url: "u", defaultBranchRef: { name: "main" }, description: "d", repositoryTopics: [] },
      { name: "b", owner: { login: "leanish" }, isArchived: true,  isFork: false, url: "u", defaultBranchRef: { name: "main" }, description: null, repositoryTopics: [] },
    ]) });
  const repos = await listRepos({ owner: "leanish", includeArchived: false, runGh });
  expect(repos.map(r => r.name)).toEqual(["a"]);
});

it("listRepos with includeArchived keeps archived", async () => { /* same fixture, includeArchived:true → ["a","b"] */ });

it("maps a missing/unauthenticated gh to GhError", async () => {
  const runGh = async () => ({ code: 127, stdout: "", stderr: "command not found: gh" });
  await expect(listRepos({ owner: "x", includeArchived: false, runGh })).rejects.toBeInstanceOf(GhError);
});
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `listRepos` builds `["repo","list", owner?, "--json","name,owner,isArchived,isFork,url,defaultBranchRef,description,repositoryTopics","--limit","1000"]` (omit owner → authenticated user's repos), calls `runGh`, on non-zero throws `GhError` (guidance: install/auth `gh`), parses JSON → `GhRepo[]`, filters `isArchived` unless `includeArchived` (forks always kept — no filter). `getRepoMeta` → `["repo","view", `${owner}/${repo}`,"--json","description,repositoryTopics"]`. Normalize `owner.login`, `defaultBranchRef.name`, `repositoryTopics[].topic.name`. Export `class GhError extends Error`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Checkpoint.**

---

## Task 7: `inspection-clone.ts`

**Files:** Create `src/inspection-clone.ts`; Test `test/unit/inspection-clone.test.ts`. Uses a `runGit` seam.

- [ ] **Step 1: Failing test**
```ts
import { withInspectionClone } from "../../src/inspection-clone.js";
import { existsSync } from "node:fs";

it("clones shallow, runs the body with the dir, and cleans up after", async () => {
  let seenDir = ""; const gitCalls: string[][] = [];
  const runGit = async (args) => { gitCalls.push(args); return { code: 0, stdout: "", stderr: "" }; };
  const result = await withInspectionClone({ url: "https://github.com/leanish/foo.git", runGit }, async (dir) => { seenDir = dir; return "ok"; });
  expect(result).toBe("ok");
  expect(gitCalls[0]).toEqual(expect.arrayContaining(["clone", "--depth", "1"]));
  expect(existsSync(seenDir)).toBe(false); // cleaned up
});

it("cleans up even when the body throws", async () => { /* body throws → dir removed, error rethrown */ });
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — compute scratch path `${CATALOGIT_SCRATCH_ROOT ?? tmpdir()}/catalogit-inspect/<owner>_<slug>-<rand>`; `runGit(["clone","--depth","1","--single-branch", ...(branch?["--branch",branch]:[]), url, dir])`; `try { return await fn(dir) } finally { await rm(dir,{recursive,force}) }`. Throw a typed error on non-zero clone code.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Checkpoint.**

---

## Task 8: `add.ts` — the single-project flow

**Files:** Create `src/add.ts`; Test `test/unit/add.test.ts`. Composes Tasks 1–7 + `validate.ts`. All seams injected.

`runAdd` signature:
```ts
export interface AddDeps { runProcess: RunProcess; runGh: RunGh; runGit: RunGit; confirm: (msg: string) => Promise<boolean>; }
export interface AddOptions { id: string; catalogRoot: string; from?: string; fromGithub?: string; agent: CodingAgent; force: boolean; skeleton: boolean; isTty: boolean; }
export async function runAdd(o: AddOptions, d: AddDeps): Promise<{ status: "added"|"overridden"|"skeleton"|"skipped"; exitCode: number }>
```

- [ ] **Step 1: Failing tests** (drive each branch with fakes; assert the written file + status):
```ts
// happy path: not cataloged, llm drafts → file written with description, status "added"
// --skeleton: skeleton written, status "skeleton"
// existing id + force: overrides, spine preserved (load old file, assert source/extensions unchanged, description changed)
// existing id, no force, isTty=false: status "skipped", exitCode 1
// existing id, no force, isTty=true, confirm()=>true: overrides
// draft throws DraftError: falls back to skeleton, status "skeleton", exitCode 4
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the spec's behavior steps (cli.md §`add`): validate id format (reuse the slug regex via a small `parseId`); `projectFileExists` → branch on `force`/`isTty`/`confirm`; materialize via `withInspectionClone` (or `--from` path, no clone); optional `getRepoMeta` for `--from-github`; `skeleton` → `writeSkeleton`; else `draftDescription` (retry once, then skeleton + exitCode 4); preserve spine on override by reading the existing record first; `writeProjectYaml`. Return status + exit code.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Checkpoint.**

---

## Task 9: `discover.ts` — discovery + batch import

**Files:** Create `src/discover.ts`; Test `test/unit/discover.test.ts`. Uses `listRepos` + `runAdd` + a `select` seam.

`runDiscover` signature:
```ts
export interface DiscoverDeps extends AddDeps { listRepos: typeof listRepos; select: (choices: { name: string; value: string; checked?: boolean }[]) => Promise<string[]>; }
export interface DiscoverOptions { owner?: string; includeArchived: boolean; add?: string[]; agent: CodingAgent; force: boolean; skeleton: boolean; catalogRoot: string; isTty: boolean; }
export async function runDiscover(o: DiscoverOptions, d: DiscoverDeps): Promise<{ summary: DiscoverSummary; exitCode: number }>
```

- [ ] **Step 1: Failing tests:**
```ts
// listRepos→[a,b,c]; --add "a,c" → runAdd called for a and c (mapped via repo-id), b skipped; summary counts
// --add "*" → every eligible repo
// interactive (isTty, no --add): select() returns chosen subset; runAdd per choice
// a repo whose name fails the slug pattern → skipped-with-reason in summary, runAdd NOT called
// non-tty + no --add → exitCode with guidance, runAdd not called
// every selected repo hard-fails → exitCode non-zero; one succeeds → exitCode 0
```
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — `listRepos`; eligibility already handled by `listRepos`; build choices marking already-cataloged (`projectFileExists`) with `[cataloged — will re-draft]`; select via `--add` (`*` = all; names matched case-insensitively) or the `select` seam (non-tty + no `--add` → guidance exit); for each pick `mapRepoToId` (skip+record malformed), then `await runAdd(...)` **sequentially**, accumulating a summary; print summary; exit non-zero only if every pick hard-failed. Export `DiscoverSummary`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Checkpoint.**

---

## Task 10: `cli.ts` wiring + `@inquirer/prompts` dep + USAGE

**Files:** Modify `src/cli.ts`, `package.json`; extend `test/unit/cli.test.ts`.

- [ ] **Step 1: Add the dep** — `npm install @inquirer/prompts` in `catalogit/` (match the registry's installable version; see the agent-runtime note about the local mirror's date cutoff if a version is rejected).
- [ ] **Step 2: Failing test** — extend `cli.test.ts`: `catalogitCli(["add","--help"])`-style or a routed call with injected deps asserting `add`/`discover` dispatch and that unknown flags error. (Factor `runAdd`/`runDiscover` calls behind a deps object the test can stub; in production `cli.ts` supplies real seams.)
- [ ] **Step 3: Implement** — add `case "add":` / `case "discover":` to the dispatcher; parse their flags with `parseFlags` (extend the allowlists; `--force`/`--skeleton` are booleans, `--add` is a string split on `,`, positional `<id>` for `add`); build the real deps: `runProcess`/`runGit` via `node:child_process` `spawn` (capture stdout/stderr, resolve `RunResult`), `runGh` = `runProcess.bind` to `"gh"`, `confirm`/`select` from `@inquirer/prompts` (`isTty = process.stdin.isTTY === true`), `agent = resolveCodingAgent(flags["coding-agent"], process.env)`. Return the command's exit code. Extend `USAGE`.
- [ ] **Step 4: Run** — `npm run check` (typecheck + build + all unit tests). Expected: green.
- [ ] **Step 5: Checkpoint.**

---

## Task 11: Manual smoke (optional, requires `gh` + a coding agent logged in)

- [ ] `node dist/bin/catalogit.js add leanish/foo --from . --skeleton --catalog-root "$(mktemp -d)/catalogit"` → writes a skeleton; `validate` passes.
- [ ] With `gh` authed: `node dist/bin/catalogit.js discover --owner <you> --skeleton --catalog-root <tmp>` → lists repos, checkbox select, writes skeletons.
- [ ] Drop `--skeleton` to exercise real drafting (uses your ambient `codex`/`claude` login).

---

## Self-review checklist (done while writing)

- **Spec coverage:** `add` (Task 8) + `discover` (Task 9) cover cli.md's behaviors; flags (`--from`, `--from-github`, `--coding-agent`, `--force`, `--skeleton`, `--add`, `--include-archived`) routed in Task 10; drafting prompt (Task 5); fenced extraction (Task 3); gh auth via `gh` (Task 6); repo→id lowercase+skip (Task 1); skeleton (Task 2); override-preserves-spine (Task 8); batch summary + exit policy (Task 9). `--review` was considered and is tracked as Considered/deferred in cli.md (not wired in code).
- **No placeholders:** every code step shows concrete test + impl intent; commands are exact (`npx vitest run …`, `npm run check`).
- **Type consistency:** `RunProcess`/`RunGh`/`RunGit`/`CodingAgent`/`GhRepo`/`AddDeps`/`DiscoverDeps` defined once and reused; `mapRepoToId` and `idToFilename` are the single id↔filename source (Task 1/2).
- **No-agent-runtime boundary preserved:** the invoker, gh wrapper, and clone manager are catalogit-local; nothing imports `@leanish/agent-runtime`.
