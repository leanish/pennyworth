import type { Project } from "./project.js";

/**
 * Serialise a catalog into the deployed JSON bundle shape from
 * `../../../specs/agentic-development/catalogit/specs/data-format.md` §Deployed shape:
 *
 *   `{"version":"1","projects":[<projects sorted by id, fields in stable order>]}`
 *
 * Determinism rules:
 *   - Top-level keys: `version` then `projects`.
 *   - Projects sorted by `id` ascending (lexicographic on the owner-qualified slug).
 *   - Per-project field order: `id`, `source`, `extensions`, `description`.
 *   - `source` fields: `url`, `branch`.
 *   - `extensions` keys sorted ascending (so per-consumer slices appear in a
 *     predictable order, useful for diffs).
 *   - Optional fields whose value is `undefined` are omitted entirely.
 *
 * Byte-identical input ⇒ byte-identical output. Useful for ETag stability and
 * for diff-friendly reviews of `catalogit publish` output.
 */
export interface BundleOptions {
  /**
   * Bundle version. Phase 1 uses `"1"` (see ADR-0014). Override only when a
   * future schema major lands.
   */
  readonly version?: string;
}

const DEFAULT_VERSION = "1";

export function bundleCatalog(
  projects: ReadonlyArray<Project>,
  options: BundleOptions = {},
): string {
  const sorted = [...projects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = {
    version: options.version ?? DEFAULT_VERSION,
    projects: sorted.map(projectFor),
  };
  return JSON.stringify(out);
}

function projectFor(project: Project): Record<string, unknown> {
  // Emit fields in the documented semantic order: id, source, extensions,
  // description. `JSON.stringify` respects insertion order for string keys
  // (ES2015 spec, not just V8 behavior), so building the object below in
  // canonical order is what produces the byte-stable bundle.
  //
  // `extensions` keys, in contrast, ARE sorted alphabetically (see
  // `extensionsFor`) because that's where curator edits to one extension
  // shouldn't churn the bundle bytes for unrelated extensions on the same
  // project.
  const out: Record<string, unknown> = {
    id: project.id,
    source: sourceFor(project),
  };
  const extensions = extensionsFor(project);
  if (extensions !== undefined) out["extensions"] = extensions;
  if (project.description !== undefined) out["description"] = project.description;
  return out;
}

function sourceFor(project: Project): Record<string, unknown> {
  return {
    url: project.source.url,
    branch: project.source.branch,
  };
}

function extensionsFor(project: Project): Record<string, unknown> | undefined {
  const keys = Object.keys(project.extensions);
  if (keys.length === 0) return undefined;
  const sortedKeys = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const value = project.extensions[key];
    if (value === undefined) continue;
    // Recursively sort nested object keys too, so a curator reordering
    // fields inside `extensions.<svc>` doesn't churn the bundle bytes.
    // This is the byte-identical-input → byte-identical-output guarantee
    // applied at every depth (not just the top-level extension namespaces).
    out[key] = sortValueDeep(value);
  }
  return out;
}

/**
 * Recursively re-emit a JSON value with object keys in ascending order.
 * Arrays preserve order (curator order is part of array semantics). Scalars
 * pass through unchanged. The result is a fresh tree — the caller's input
 * is never mutated.
 */
function sortValueDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValueDeep);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const v = obj[key];
    if (v === undefined) continue;
    sorted[key] = sortValueDeep(v);
  }
  return sorted;
}
