/**
 * Runtime-owned references to checked-out project working copies. Returned
 * by `runtime.syncWorkingCopies(projects)` and consumed by `runtime.runSkill`.
 *
 * Phase-1 choices:
 *   - `path` is an absolute filesystem path under the runtime's
 *     workspace root. The handler does not own its layout.
 *   - `branch` is the locally checked-out branch (matches the project's
 *     `source.branch` after a sync).
 *   - `headSha` is the commit the working copy is pinned at after sync.
 *
 * See ADR-0008.
 */
export interface WorkingCopy {
  readonly projectId: string;
  readonly path: string;
  readonly branch: string;
  readonly headSha: string;
}

/**
 * Per-project outcome from a `syncWorkingCopies` call.
 *
 *   - `cloned` — the working copy did not exist; created from scratch.
 *   - `fast-forward` — existed at a strict ancestor of the remote head; advanced.
 *   - `no-change` — already at the expected head.
 *   - `reset` — existed but diverged; reset hard to remote (phase-1 default for
 *     dirty / divergent local state).
 *   - `dedup` — a sync for this project already happened in this process;
 *     reused the existing working copy without touching git.
 */
export type SyncOutcome =
  | "cloned"
  | "fast-forward"
  | "no-change"
  | "reset"
  | "dedup";

export interface SyncReportEntry {
  readonly projectId: string;
  readonly outcome: SyncOutcome;
  readonly fromSha?: string;
  readonly toSha: string;
}

export interface SyncResult {
  readonly workingCopies: ReadonlyArray<WorkingCopy>;
  readonly report: ReadonlyArray<SyncReportEntry>;
}
