import type { Project } from "@leanish/catalog-it";

import type { SyncResult } from "../types/working-copy.js";

/**
 * Workspace abstraction. AWS-mode + local-mode (CLI-driven `git`)
 * implementations live alongside each other and share this interface.
 *
 * Implementations MUST deduplicate within a single process: a second
 * `sync()` for an already-synced project returns the same `WorkingCopy`
 * with `outcome: "dedup"` and no remote round-trip.
 */
export interface Workspace {
  sync(projects: ReadonlyArray<Project>): Promise<SyncResult>;
}
