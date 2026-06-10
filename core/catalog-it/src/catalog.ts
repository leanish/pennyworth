import type { Project } from "./project.js";

/**
 * Read-only catalog access. Each `CatalogReadOnly` impl (filesystem, S3,
 * in-memory) serves catalogit's library API.
 *
 * **Consumer-scoped access only.** The runtime intentionally exposes
 * `forConsumer(...)` as the primary surface — see ADR-0005 and
 * `overview.md` §Catalog access. An umbrella `list()`
 * / `get()` is provided for callers that genuinely need unscoped access
 * (catalogit's own diagnostics, tests), but Layer-3 agents are expected
 * to go through `forConsumer(<agent-id>)` so opt-in semantics apply
 * automatically.
 */
export interface CatalogReadOnly {
  /**
   * Every project in the catalog, unscoped. Most agents should use
   * `forConsumer(<id>).list()` instead.
   */
  list(): ReadonlyArray<Project>;
  /** Unscoped lookup by `Project.id`. */
  get(id: string): Project | undefined;
  /**
   * The agent-scoped view. Applies the default-on opt-in filter
   * (`extensions.<consumerId>.enabled !== false`) before returning.
   */
  forConsumer(consumerId: string): ConsumerCatalogView;
}

export interface ConsumerCatalogView {
  list(): ReadonlyArray<Project>;
  get(id: string): Project | undefined;
}
