import type { Project } from "./project.js";

/**
 * Default-on consumer filter (catalogit's convention from suite-0008):
 *
 *   - explicit `extensions.<consumerId>.enabled === false` → out.
 *   - absence, explicit `true`, or non-boolean value → in.
 *
 * This is the single source of truth for which projects show up under
 * `runtime.catalog.forConsumer(<agent-id>).list()`. Every catalog impl
 * applies it the same way.
 */
export function isEnabledForConsumer(project: Project, consumerId: string): boolean {
  const slice = project.extensions[consumerId];
  if (slice === undefined || slice === null) return true;
  if (typeof slice !== "object" || Array.isArray(slice)) return true;
  const enabled = (slice as Record<string, unknown>)["enabled"];
  if (enabled === false) return false;
  return true;
}
