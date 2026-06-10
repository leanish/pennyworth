import type { Project } from "@leanish/catalog-it";

import type {
  SyncOutcome,
  SyncResult,
  SyncReportEntry,
  WorkingCopy,
} from "../types/working-copy.js";

import type { Workspace } from "./workspace.js";

/**
 * Workspace that fabricates `WorkingCopy` records without touching disk
 * or git. Used in tests where the agent contract is what's being exercised
 * and the on-disk source isn't.
 *
 * The `path` returned is a synthetic `/synthetic/<projectId>` string. Tests
 * that need to write into the path should override `pathFor`.
 *
 * Outcomes the fake can produce (matches the spec's 5-way `SyncOutcome`):
 *
 *   - `cloned`        — first sync for the project (or first since
 *                       `setExpectedOutcome` declared a fresh value).
 *   - `dedup`         — a sync for this project already happened in the
 *                       same `InMemoryWorkspace`; reuses the existing
 *                       working copy without mutating the report shape.
 *   - `no-change`     — opt-in via `setExpectedOutcome(id, "no-change", sha)`;
 *                       returns the existing working copy with `toSha`
 *                       matching the previously synced sha.
 *   - `fast-forward`  — opt-in via `setExpectedOutcome(id, "fast-forward", newSha)`;
 *                       advances the stored `headSha` while preserving
 *                       `branch` + `path`, and emits a `fromSha`/`toSha`
 *                       report entry.
 *   - `reset`         — opt-in via `setExpectedOutcome(id, "reset", newSha)`;
 *                       same shape as `fast-forward` but the outcome string
 *                       tells the consumer the local state diverged.
 *
 * Per-test overrides are queued via `setExpectedOutcome`; the next `sync()`
 * for that project consumes the queue entry and reverts to the default
 * cloned/dedup behaviour after.
 */
export interface InMemoryWorkspaceOptions {
  readonly pathFor?: (project: Project) => string;
  readonly shaFor?: (project: Project) => string;
}

interface ScheduledOutcome {
  readonly outcome: Exclude<SyncOutcome, "cloned" | "dedup">;
  readonly toSha: string;
}

export class InMemoryWorkspace implements Workspace {
  readonly #synced = new Map<string, WorkingCopy>();
  readonly #scheduled = new Map<string, ScheduledOutcome>();
  readonly #options: InMemoryWorkspaceOptions;

  constructor(options: InMemoryWorkspaceOptions = {}) {
    this.#options = options;
  }

  /**
   * Force the **next** `sync()` call for `projectId` to report the given
   * non-default outcome. The first sync must have already happened
   * (otherwise there's nothing to "fast-forward" or "reset" from);
   * `cloned` is implicit on first sync. Single-use — once consumed the
   * queue entry is dropped.
   */
  setExpectedOutcome(
    projectId: string,
    outcome: ScheduledOutcome["outcome"],
    toSha: string,
  ): void {
    this.#scheduled.set(projectId, { outcome, toSha });
  }

  async sync(projects: ReadonlyArray<Project>): Promise<SyncResult> {
    const workingCopies: WorkingCopy[] = [];
    const report: SyncReportEntry[] = [];
    for (const project of projects) {
      const existing = this.#synced.get(project.id);
      const scheduled = this.#scheduled.get(project.id);

      if (existing !== undefined && scheduled !== undefined) {
        // Honor the test's scheduled outcome — advance / reset the head.
        this.#scheduled.delete(project.id);
        const advanced: WorkingCopy = {
          projectId: existing.projectId,
          path: existing.path,
          branch: existing.branch,
          headSha: scheduled.toSha,
        };
        this.#synced.set(project.id, advanced);
        workingCopies.push(advanced);
        report.push({
          projectId: project.id,
          outcome: scheduled.outcome,
          fromSha: existing.headSha,
          toSha: scheduled.toSha,
        });
        continue;
      }

      if (existing !== undefined) {
        // Default: a repeated sync without a scheduled outcome is a dedup.
        workingCopies.push(existing);
        report.push({
          projectId: project.id,
          outcome: "dedup",
          toSha: existing.headSha,
        });
        continue;
      }

      // First sync for this project.
      const workingCopy: WorkingCopy = {
        projectId: project.id,
        path: this.#pathFor(project),
        branch: project.source.branch,
        headSha: this.#shaFor(project),
      };
      this.#synced.set(project.id, workingCopy);
      workingCopies.push(workingCopy);
      report.push({
        projectId: project.id,
        outcome: "cloned",
        toSha: workingCopy.headSha,
      });
    }
    return { workingCopies, report };
  }

  #pathFor(project: Project): string {
    return this.#options.pathFor?.(project) ?? `/synthetic/${project.id}`;
  }

  #shaFor(project: Project): string {
    return this.#options.shaFor?.(project) ?? "0".repeat(40);
  }
}
