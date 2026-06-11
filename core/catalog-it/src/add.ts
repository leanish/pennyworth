/**
 * Orchestrates the `catalogit add` flow for a single project:
 * validate id → check existence → optionally draft via coding agent → write YAML.
 *
 * All I/O is injected through AddDeps so tests run without subprocesses or
 * network access.
 */

import { stat } from "node:fs/promises";

import { type CodingAgent, type RunProcess, DraftError, draftDescription } from "./coding-agent.js";
import { buildDraftingPrompt } from "./drafting-prompt.js";
import { loadProjectFile } from "./filesystem-catalog.js";
import { type RepoMeta, type RunGh, getRepoMeta } from "./github.js";
import { type RunGit, withInspectionClone } from "./inspection-clone.js";
import type { Project, ProjectSource } from "./project.js";
import { projectFileExists, writeProjectYaml, writeSkeleton } from "./project-writer.js";
import { mapRepoToId } from "./repo-id.js";

/**
 * Minimal output sink. The CLI wires its injected `stderr` stream; tests pass
 * a capture or no-op sink. Keeping the surface to `write(string)` means both
 * `NodeJS.WritableStream` (process / CLI streams) and a plain `{ write }` test
 * double satisfy it without casts.
 */
export interface OutputSink {
  write(chunk: string): void;
}

export interface AddDeps {
  readonly runProcess: RunProcess;
  readonly runGh: RunGh;
  readonly runGit: RunGit;
  readonly confirm: (message: string) => Promise<boolean>;
  /** Diagnostic / error output. Replaces the old direct `console.error`. */
  readonly stderr: OutputSink;
}

export interface AddOptions {
  readonly id: string;
  readonly catalogRoot: string;
  readonly from?: string;
  readonly fromGithub?: string;
  readonly agent: CodingAgent;
  readonly force: boolean;
  readonly skeleton: boolean;
  readonly isTty: boolean;
}

export type AddStatus = "added" | "overridden" | "skeleton" | "skipped";

const URL_RE = /^https?:\/\/|^git@/;

/** Interval between "still drafting…" liveness ticks on stderr. */
const DRAFT_HEARTBEAT_MS = 30_000;

/** Split `"owner/repo"` on the first slash. `repo` is `""` when there's no slash. */
function splitOwnerRepo(input: string): { owner: string; repo: string } {
  const slash = input.indexOf("/");
  return slash === -1
    ? { owner: input, repo: "" }
    : { owner: input.slice(0, slash), repo: input.slice(slash + 1) };
}

/** Returns true when `path` is an existing directory on the local filesystem. */
async function isLocalDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function runAdd(
  o: AddOptions,
  d: AddDeps,
): Promise<{ status: AddStatus; exitCode: number }> {
  // 1. Validate id
  const { owner: rawOwner, repo: rawRepo } = splitOwnerRepo(o.id);
  const mapped = mapRepoToId(rawOwner, rawRepo);
  if (!mapped.ok) {
    d.stderr.write(`catalogit add: invalid id "${o.id}": ${mapped.reason}\n`);
    return { status: "skipped", exitCode: 1 };
  }
  const { id, owner, slug } = mapped;

  // 2. Exists check
  const exists = await projectFileExists(o.catalogRoot, id);
  if (exists && !o.force) {
    if (o.isTty) {
      const ok = await d.confirm(
        `${id} is already cataloged; re-draft its description (spine preserved)?`,
      );
      if (!ok) return { status: "skipped", exitCode: 0 };
    } else {
      d.stderr.write(
        `catalogit add: "${id}" is already cataloged. Use --force to re-draft, or edit the file directly.\n`,
      );
      return { status: "skipped", exitCode: 1 };
    }
  }

  // 3. Derive source.url
  const derivedUrl = `https://github.com/${owner}/${slug}.git`;
  const sourceUrl =
    o.from !== undefined && URL_RE.test(o.from) ? o.from : derivedUrl;

  // 4. Spine preservation: default to a fresh spine; when overriding an
  // existing record, preserve its source + extensions (curator opt-outs).
  let source: ProjectSource = { url: sourceUrl, branch: "main" };
  let extensions: Readonly<Record<string, unknown>> = {};
  if (exists) {
    const existing = await loadProjectFile(o.catalogRoot, id);
    if (existing !== undefined) {
      source = existing.source;
      extensions = existing.extensions;
    }
  }

  // 5. --skeleton → no drafting
  if (o.skeleton) {
    if (exists) {
      // Override under --skeleton: preserve the existing spine (source + extensions),
      // drop only the description. Writing a bare skeleton here would wipe curator
      // opt-outs, violating the override-preserves-spine guarantee.
      const preserved: Project = { id, source, extensions };
      await writeProjectYaml(o.catalogRoot, preserved);
      return { status: "overridden", exitCode: 0 };
    }
    await writeSkeleton(o.catalogRoot, id, source.url);
    return { status: "skeleton", exitCode: 0 };
  }

  // 6. Draft (with one retry on DraftError). Drafting clones + runs a coding
  // agent and can take minutes with no output of its own — announce it so
  // interactive `add`/`discover` runs don't look hung.
  d.stderr.write(`drafting "${id}" via ${o.agent} — this can take a few minutes…\n`);

  let githubMeta: RepoMeta | undefined;
  if (o.fromGithub !== undefined) {
    const { owner: ghOwner, repo: ghRepo } = splitOwnerRepo(o.fromGithub);
    githubMeta = await getRepoMeta({ owner: ghOwner, repo: ghRepo, runGh: d.runGh });
  } else if (!exists) {
    // Plain `add <owner/repo>`: resolve the repo's REAL default branch so a
    // fresh spine doesn't hardcode "main" (the inspection clone checks out
    // the default HEAD either way, so a wrong recorded branch otherwise goes
    // unnoticed until something consumes it). Soft fallback — `gh` being
    // absent/offline must not break a plain add.
    try {
      githubMeta = await getRepoMeta({ owner, repo: slug, runGh: d.runGh });
    } catch {
      d.stderr.write(
        `catalogit add: could not resolve the default branch for "${id}"; assuming "main".\n`,
      );
    }
  }
  if (!exists && githubMeta !== undefined) {
    source = { url: sourceUrl, branch: githubMeta.defaultBranch };
  }

  const prompt = buildDraftingPrompt(
    githubMeta !== undefined ? { id, githubMeta } : { id },
  );

  async function attemptDraft(dir: string): Promise<string> {
    try {
      return await draftDescription({ agent: o.agent, cwd: dir, prompt, runProcess: d.runProcess });
    } catch (err) {
      if (err instanceof DraftError) {
        // Retry once
        return await draftDescription({ agent: o.agent, cwd: dir, prompt, runProcess: d.runProcess });
      }
      throw err;
    }
  }

  // Liveness heartbeat: the agent subprocess produces no output of its own,
  // so tick on stderr while it runs to distinguish "working" from "hung".
  const draftStartedAt = Date.now();
  const elapsedS = (): number => Math.round((Date.now() - draftStartedAt) / 1000);
  const heartbeat = setInterval(() => {
    d.stderr.write(`still drafting "${id}" via ${o.agent}… (${elapsedS()}s elapsed)\n`);
  }, DRAFT_HEARTBEAT_MS);

  let description: string;
  try {
    if (o.from !== undefined && (await isLocalDir(o.from))) {
      description = await attemptDraft(o.from);
    } else {
      description = await withInspectionClone(
        { url: source.url, runGit: d.runGit },
        (dir) => attemptDraft(dir),
      );
    }
  } catch (err) {
    if (err instanceof DraftError) {
      d.stderr.write(
        `catalogit add: agent failed twice for "${id}"; writing skeleton. Run again to retry.\n`,
      );
      await writeSkeleton(o.catalogRoot, id, source.url);
      return { status: "skeleton", exitCode: 4 };
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
  }

  // 7. Write full project record
  const project: Project = { id, source, extensions, description };
  await writeProjectYaml(o.catalogRoot, project);
  d.stderr.write(`drafted "${id}" in ${elapsedS()}s\n`);

  return { status: exists ? "overridden" : "added", exitCode: 0 };
}
