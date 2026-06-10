import type { Project, Runtime } from "@leanish/runtime";

import type { AtcRequest } from "./request-schema.js";
import { AtcValidationError } from "./request-schema.js";

/**
 * The shape passed to the `ask` skill's input. Matches the skill spec's
 * `projectScope` schema verbatim.
 */
export interface ProjectScope {
  readonly source: ProjectScopeSource;
  readonly projects: ReadonlyArray<{ readonly id: string }>;
}

export type ProjectScopeSource =
  | "payload-project-ids"
  | "payload-include-all"
  | "router-selection"
  | "router-empty-fallback";

export interface ResolvedScope {
  readonly scope: ProjectScope;
  readonly projects: ReadonlyArray<Project>;
}

/**
 * Resolve the request into a `ProjectScope` + the concrete `Project[]`.
 * Per queue-api.md §kind: "ask" field rules:
 *
 *   - `projectIds` non-empty → `catalog.forConsumer("ask-the-code").get()` per id;
 *     **any id that is not in the catalog throws** `AtcValidationError`.
 *     Silently skipping unknown ids would degrade an explicit consumer
 *     intent into a narrower query without surfacing the typo / opt-out.
 *     → source: "payload-project-ids".
 *   - `includeAll: true` (with no `projectIds`) → `catalog.forConsumer.list()`
 *     → source: "payload-include-all".
 *   - else → `routeProjects({ task: question, forConsumer: "ask-the-code" })`. The
 *     handler does not catch the router throw — a missing router is a
 *     deploy-time configuration error that the runtime surfaces as
 *     `RouterNotConfiguredError`, and the caller's `mapErrorKind` maps
 *     that to `config-error`. Only a *successfully-returned* empty
 *     route falls back to the full opted-in list.
 *     → if router returns non-empty: source: "router-selection"
 *     → if router returns empty:     source: "router-empty-fallback".
 */
export async function resolveProjectScope(
  request: AtcRequest,
  runtime: Runtime,
): Promise<ResolvedScope> {
  const consumer = runtime.catalog.forConsumer("ask-the-code");

  if (request.projectIds !== undefined && request.projectIds.length > 0) {
    const projects: Project[] = [];
    const unknown: string[] = [];
    for (const id of request.projectIds) {
      const p = consumer.get(id);
      if (p === undefined) {
        unknown.push(id);
        continue;
      }
      projects.push(p);
    }
    if (unknown.length > 0) {
      throw new AtcValidationError(
        `request.projectIds references unknown project id${unknown.length === 1 ? "" : "s"}: [${unknown.join(", ")}]`,
      );
    }
    return scopeFor("payload-project-ids", projects);
  }

  if (request.includeAll === true) {
    return scopeFor("payload-include-all", consumer.list());
  }

  // Router-driven default. Let the runtime's `routeProjects` throw on
  // missing-router config — the handler maps `RouterNotConfiguredError`
  // to `config-error` rather than silently using the whole catalog.
  //
  // The `task` is framed as an ATC answering task (rather than the bare
  // question) so the router has the intent signal alongside the content.
  // Routers are shared across consumers (per ADR-0005), so the framing
  // keeps the router prompt-neutral while disambiguating the request.
  const routed = await runtime.routeProjects({
    task: `Answer this ask-the-code question: ${request.question}`,
    forConsumer: "ask-the-code",
  });
  if (routed.length > 0) {
    return scopeFor("router-selection", routed);
  }
  return scopeFor("router-empty-fallback", consumer.list());
}

function scopeFor(
  source: ProjectScopeSource,
  projects: ReadonlyArray<Project>,
): ResolvedScope {
  return {
    scope: { source, projects: projects.map((p) => ({ id: p.id })) },
    projects,
  };
}
