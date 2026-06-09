import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { CatalogReadOnly, ConsumerCatalogView } from "./catalog.js";
import { isEnabledForConsumer } from "./consumer-filter.js";
import type { Project } from "./project.js";
import {
  assertNoUnknownKeys,
  PROJECT_SOURCE_KEYS,
  PROJECT_SPINE_KEYS,
} from "./spine-keys.js";

/**
 * Local-mode catalog client. Reads catalogit's per-project YAML layout
 * (one file per project under `<catalogRoot>/projects/<owner>_<slug>.yaml`)
 * and serves the read-only catalog surface.
 *
 * AWS-mode equivalent (`S3Catalog`) reads the bundled `catalog.json` from
 * S3; the `CatalogReadOnly` interface is shared so handlers don't branch
 * on mode.
 *
 * See `../../../specs/agentic-development/catalogit/specs/data-format.md`.
 */
export interface FilesystemCatalogOptions {
  readonly catalogRoot: string;
}

export class FilesystemCatalog implements CatalogReadOnly {
  readonly #projects: ReadonlyMap<string, Project>;

  private constructor(projects: ReadonlyMap<string, Project>) {
    this.#projects = projects;
  }

  static async load(options: FilesystemCatalogOptions): Promise<FilesystemCatalog> {
    const projectsDir = join(options.catalogRoot, "projects");
    const entries = await readdir(projectsDir);
    const projects = new Map<string, Project>();
    for (const entry of entries) {
      if (!entry.endsWith(".yaml")) continue;
      const filePath = join(projectsDir, entry);
      const raw = await readFile(filePath, "utf8");
      const project = parseProjectYaml(raw, filePath);
      projects.set(project.id, project);
    }
    return new FilesystemCatalog(projects);
  }

  list(): ReadonlyArray<Project> {
    return [...this.#projects.values()];
  }

  get(id: string): Project | undefined {
    return this.#projects.get(id);
  }

  forConsumer(consumerId: string): ConsumerCatalogView {
    const enabledProjects = this.list().filter(
      (project) => isEnabledForConsumer(project, consumerId),
    );
    return {
      list: () => enabledProjects,
      get: (id: string) => enabledProjects.find((project) => project.id === id),
    };
  }
}

/** Visible for testing. */
export function parseProjectYaml(raw: string, source: string): Project {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `failed to parse project YAML at ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`project YAML at ${source} must be a mapping`);
  }
  const value = parsed as Record<string, unknown>;
  const locate = `project YAML at ${source}`;
  assertNoUnknownKeys(value, PROJECT_SPINE_KEYS, { locate });
  const id = expectStringRaw(value["id"], "id", source);
  const sourceField = expectObjectRaw(value["source"], "source", source);
  assertNoUnknownKeys(sourceField, PROJECT_SOURCE_KEYS, { locate, prefix: "source." });
  const url = expectStringRaw(sourceField["url"], "source.url", source);
  const branchRaw = sourceField["branch"];
  const branch =
    branchRaw === undefined
      ? "main"
      : expectStringRaw(branchRaw, "source.branch", source);
  const descriptionRaw = value["description"];
  const description =
    descriptionRaw === undefined
      ? undefined
      : expectStringRaw(descriptionRaw, "description", source);
  const extensionsRaw = value["extensions"];
  const extensions =
    extensionsRaw === undefined
      ? {}
      : expectObjectRaw(extensionsRaw, "extensions", source);
  return {
    id,
    source: { url, branch },
    ...(description !== undefined ? { description } : {}),
    extensions,
  };
}

function expectStringRaw(raw: unknown, field: string, source: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`project YAML at ${source} requires non-empty string '${field}'`);
  }
  return raw;
}

function expectObjectRaw(
  raw: unknown,
  field: string,
  source: string,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`project YAML at ${source} requires object '${field}'`);
  }
  return raw as Record<string, unknown>;
}
