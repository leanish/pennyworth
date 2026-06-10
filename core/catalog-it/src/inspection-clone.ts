/**
 * Shallow-clone manager for repository inspection.
 * Creates a temporary clone dir, runs a body function with it, then removes it.
 * All git execution goes through an injected `RunGit` seam — no real subprocesses in tests.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type { RunResult } from "./coding-agent.js";

export type RunGit = (args: readonly string[]) => Promise<RunResult>;

export class CloneError extends Error {}

function scratchRoot(): string {
  return join(
    process.env["CATALOGIT_SCRATCH_ROOT"] ?? tmpdir(),
    "catalogit-inspect",
  );
}

/**
 * Shallow-clones a repository into a unique scratch directory, runs `fn` with
 * the directory path, then removes the directory unconditionally.
 *
 * The clone directory is created before `fn` is called so cleanup always has
 * something to remove (even when `runGit` is a test double that doesn't write files).
 */
export async function withInspectionClone<T>(
  opts: { url: string; branch?: string; runGit: RunGit },
  fn: (cloneDir: string) => Promise<T>,
): Promise<T> {
  const { url, runGit } = opts;
  const dir = join(scratchRoot(), randomBytes(8).toString("hex"));

  await mkdir(dir, { recursive: true });

  const cloneArgs: string[] = [
    "clone",
    "--depth",
    "1",
    "--single-branch",
    ...(opts.branch !== undefined ? ["--branch", opts.branch] : []),
    url,
    dir,
  ];

  const result = await runGit(cloneArgs);
  if (result.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new CloneError(
      `git clone failed (exit ${result.code}): ${result.stderr}`,
    );
  }

  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
