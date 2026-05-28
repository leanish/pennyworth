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
import { FilesystemCatalog } from "./filesystem-catalog.js";
import { type RunGh, getRepoMeta } from "./github.js";
import { type RunGit, withInspectionClone } from "./inspection-clone.js";
import type { Project, ProjectSource } from "./project.js";
import { projectFileExists, writeProjectYaml, writeSkeleton } from "./project-writer.js";
import { mapRepoToId } from "./repo-id.js";

export interface AddDeps {
  readonly runProcess: RunProcess;
  readonly runGh: RunGh;
  readonly runGit: RunGit;
  readonly confirm: (message: string) => Promise<boolean>;
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
  const slash = o.id.indexOf("/");
  const rawOwner = slash === -1 ? o.id : o.id.slice(0, slash);
  const rawRepo = slash === -1 ? "" : o.id.slice(slash + 1);
  const mapped = mapRepoToId(rawOwner, rawRepo);
  if (!mapped.ok) {
    console.error(`catalogit add: invalid id "${o.id}": ${mapped.reason}`);
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
      console.error(
        `catalogit add: "${id}" is already cataloged. Use --force to re-draft, or edit the file directly.`,
      );
      return { status: "skipped", exitCode: 1 };
    }
  }

  // 3. Derive source.url
  const derivedUrl = `https://github.com/${owner}/${slug}.git`;
  const sourceUrl =
    o.from !== undefined && URL_RE.test(o.from) ? o.from : derivedUrl;

  // 4. Spine preservation
  let source: ProjectSource;
  let extensions: Readonly<Record<string, unknown>>;

  if (exists) {
    const catalog = await FilesystemCatalog.load({ catalogRoot: o.catalogRoot });
    const existing = catalog.get(id);
    if (existing !== undefined) {
      source = existing.source;
      extensions = existing.extensions;
    } else {
      source = { url: sourceUrl, branch: "main" };
      extensions = {};
    }
  } else {
    source = { url: sourceUrl, branch: "main" };
    extensions = {};
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

  // 6. Draft (with one retry on DraftError)
  let githubMeta: { description: string | null; topics: readonly string[] } | undefined;
  if (o.fromGithub !== undefined) {
    const ghSlash = o.fromGithub.indexOf("/");
    const ghOwner = ghSlash === -1 ? o.fromGithub : o.fromGithub.slice(0, ghSlash);
    const ghRepo = ghSlash === -1 ? "" : o.fromGithub.slice(ghSlash + 1);
    githubMeta = await getRepoMeta({ owner: ghOwner, repo: ghRepo, runGh: d.runGh });
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
      console.error(
        `catalogit add: agent failed twice for "${id}"; writing skeleton. Run again to retry.`,
      );
      await writeSkeleton(o.catalogRoot, id, source.url);
      return { status: "skeleton", exitCode: 4 };
    }
    throw err;
  }

  // 7. Write full project record
  const project: Project = { id, source, extensions, description };
  await writeProjectYaml(o.catalogRoot, project);

  return { status: exists ? "overridden" : "added", exitCode: 0 };
}
