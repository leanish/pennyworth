import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { Project } from "@leanish/catalog-it";

import type { SyncOutcome, SyncReportEntry, SyncResult, WorkingCopy } from "../types/working-copy.js";

import type { Workspace } from "./workspace.js";

/**
 * Local-mode workspace backed by the `git` CLI. Assumes:
 *   - `git` is on PATH;
 *   - clone URLs the host can reach without extra credentials (or with
 *     credentials available via the user's git config);
 *   - we may force-reset when the local copy has diverged from the remote
 *     tracked branch (phase-1 default; agents that care about local edits
 *     should bring their own workspace).
 *
 * Per-process dedup is keyed on `project.id` — a second sync within the
 * same process returns the cached working copy with `outcome: "dedup"`.
 */
export interface LocalGitWorkspaceOptions {
  readonly workspaceRoot: string;
  /** Override `git` binary path (defaults to looking it up on PATH). */
  readonly gitBin?: string;
}

export class LocalGitWorkspace implements Workspace {
  readonly #root: string;
  readonly #git: string;
  readonly #synced = new Map<string, WorkingCopy>();

  constructor(options: LocalGitWorkspaceOptions) {
    this.#root = options.workspaceRoot;
    this.#git = options.gitBin ?? "git";
  }

  async sync(projects: ReadonlyArray<Project>): Promise<SyncResult> {
    await mkdir(this.#root, { recursive: true });
    const workingCopies: WorkingCopy[] = [];
    const report: SyncReportEntry[] = [];
    for (const project of projects) {
      const cached = this.#synced.get(project.id);
      if (cached !== undefined) {
        workingCopies.push(cached);
        report.push({
          projectId: project.id,
          outcome: "dedup",
          toSha: cached.headSha,
        });
        continue;
      }
      const result = await this.#syncOne(project);
      this.#synced.set(project.id, result.workingCopy);
      workingCopies.push(result.workingCopy);
      report.push(result.report);
    }
    return { workingCopies, report };
  }

  async #syncOne(
    project: Project,
  ): Promise<{ workingCopy: WorkingCopy; report: SyncReportEntry }> {
    const path = join(this.#root, sanitizeProjectId(project.id));
    const branch = project.source.branch;
    if (!existsSync(path)) {
      await this.#run("clone", ["clone", "--branch", branch, project.source.url, path]);
      const headSha = await this.#headSha(path);
      return {
        workingCopy: { projectId: project.id, path, branch, headSha },
        report: { projectId: project.id, outcome: "cloned", toSha: headSha },
      };
    }
    const fromSha = await this.#headSha(path);
    await this.#run("fetch", ["-C", path, "fetch", "origin", branch]);
    const localHead = await this.#headSha(path);
    const remoteHead = await this.#rev(path, `origin/${branch}`);
    if (localHead === remoteHead) {
      return {
        workingCopy: { projectId: project.id, path, branch, headSha: localHead },
        report: { projectId: project.id, outcome: "no-change", fromSha, toSha: localHead },
      };
    }
    const isAncestor = await this.#isAncestor(path, localHead, remoteHead);
    let outcome: SyncOutcome;
    if (isAncestor) {
      await this.#run("merge", ["-C", path, "merge", "--ff-only", `origin/${branch}`]);
      outcome = "fast-forward";
    } else {
      await this.#run("reset", ["-C", path, "reset", "--hard", `origin/${branch}`]);
      outcome = "reset";
    }
    const toSha = await this.#headSha(path);
    return {
      workingCopy: { projectId: project.id, path, branch, headSha: toSha },
      report: { projectId: project.id, outcome, fromSha, toSha },
    };
  }

  async #headSha(path: string): Promise<string> {
    return this.#rev(path, "HEAD");
  }

  async #rev(path: string, ref: string): Promise<string> {
    const { stdout } = await this.#capture(["-C", path, "rev-parse", ref]);
    return stdout.trim();
  }

  async #isAncestor(path: string, ancestor: string, descendant: string): Promise<boolean> {
    const code = await this.#runStatus(["-C", path, "merge-base", "--is-ancestor", ancestor, descendant]);
    return code === 0;
  }

  async #run(label: string, args: ReadonlyArray<string>): Promise<void> {
    const code = await this.#runStatus(args);
    if (code !== 0) {
      throw new Error(`git ${label} exited with code ${code}; args=[${args.join(" ")}]`);
    }
  }

  #runStatus(args: ReadonlyArray<string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#git, [...args], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });
  }

  #capture(args: ReadonlyArray<string>): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#git, [...args], { stdio: ["ignore", "pipe", "inherit"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve({ stdout });
        else reject(new Error(`git ${args.join(" ")} exited with code ${code}`));
      });
    });
  }
}

function sanitizeProjectId(id: string): string {
  // owner/slug → owner__slug; safe for a filesystem directory under WORKSPACE_ROOT.
  return id.replace(/\//g, "__");
}
