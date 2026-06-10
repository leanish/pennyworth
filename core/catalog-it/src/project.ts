/**
 * The Project shape every catalogit reader produces and every agent
 * consumes. Spine fields (`id`, `source`) are load-bearing; `description`
 * is free-form prose; `extensions` is the opt-in / per-consumer-config
 * bag (each Layer-3 agent reads its own namespace).
 *
 * See `data-format.md` §Spine reference.
 */
export interface Project {
  readonly id: string; // owner-qualified slug, e.g. "leanish/foo"
  readonly source: ProjectSource;
  readonly description?: string;
  readonly extensions: Readonly<Record<string, unknown>>;
}

/**
 * Where the project's source code lives. Phase 1 supports GitHub only.
 *
 * **No `kind` / `type` discriminator** by design. Adding one preemptively
 * would be speculative (`kind: "github"` is the only value with no second
 * variant in sight); we'll widen the shape additively when a non-GitHub
 * source earns its keep. See ADR-0012.
 */
export interface ProjectSource {
  readonly url: string;
  readonly branch: string;
}
