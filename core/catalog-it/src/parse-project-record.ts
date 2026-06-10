import type { Project } from "./project.js";
import { assertNoUnknownKeys, PROJECT_SOURCE_KEYS, PROJECT_SPINE_KEYS } from "./spine-keys.js";

/** Extension namespace keys match this (data-format.md §Validation). */
const EXTENSION_KEY_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Parse a project record's structural spine into a `Project`, strict-by-default
 * (ADR-0014). The single shared parser for both readers — `FilesystemCatalog`
 * parses YAML to a record and delegates here; `S3Catalog` does the same for each
 * bundle entry — so the two can never diverge on what they accept (previously
 * the S3 path silently coerced a bad `branch`/`description` that the filesystem
 * path rejected).
 *
 * `locate` is the caller's context for error messages, e.g.
 * `project YAML at <path>` or `S3Catalog: <src> projects[3]`.
 *
 * Spine rules (data-format.md §Validation):
 *   - `id` — required, non-empty string
 *   - `source` — required object; `source.url` required non-empty string;
 *     `source.branch` optional (defaults to `"main"`), non-empty string when present
 *   - `description` — optional; any string when present (empty allowed)
 *   - `extensions` — optional (defaults to `{}`); a map whose top-level keys
 *     match `[a-z][a-z0-9-]*` and whose values are JSON objects
 */
export function parseProjectRecord(value: Record<string, unknown>, locate: string): Project {
  assertNoUnknownKeys(value, PROJECT_SPINE_KEYS, { locate });

  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${locate} requires non-empty string 'id'`);
  }

  const source = value["source"];
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    throw new Error(`${locate} requires object 'source'`);
  }
  const sourceMap = source as Record<string, unknown>;
  assertNoUnknownKeys(sourceMap, PROJECT_SOURCE_KEYS, { locate, prefix: "source." });

  const url = sourceMap["url"];
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`${locate} requires non-empty string 'source.url'`);
  }

  const branchRaw = sourceMap["branch"];
  let branch: string;
  if (branchRaw === undefined) {
    branch = "main";
  } else if (typeof branchRaw === "string" && branchRaw.length > 0) {
    branch = branchRaw;
  } else {
    throw new Error(`${locate} requires non-empty string 'source.branch' when present`);
  }

  const descriptionRaw = value["description"];
  let description: string | undefined;
  if (descriptionRaw === undefined) {
    description = undefined;
  } else if (typeof descriptionRaw === "string") {
    description = descriptionRaw;
  } else {
    throw new Error(`${locate} requires string 'description' when present`);
  }

  const extensions = parseExtensions(value["extensions"], locate);

  return {
    id,
    source: { url, branch },
    ...(description !== undefined ? { description } : {}),
    extensions,
  };
}

function parseExtensions(raw: unknown, locate: string): Record<string, unknown> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${locate} requires map 'extensions' when present`);
  }
  const extensions = raw as Record<string, unknown>;
  for (const [key, val] of Object.entries(extensions)) {
    if (!EXTENSION_KEY_RE.test(key)) {
      throw new Error(
        `${locate} extensions key '${key}' must match ${EXTENSION_KEY_RE.source}`,
      );
    }
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
      throw new Error(`${locate} extensions.${key} must be a JSON object`);
    }
  }
  return extensions;
}
