import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { CatalogReadOnly, ConsumerCatalogView } from "./catalog.js";
import { isEnabledForConsumer } from "./consumer-filter.js";
import type { Project } from "./project.js";
import { CatalogIoError, CatalogLoadError, type CatalogLoadIssue, errorMessage } from "./errors.js";
import { parseProjectRecord } from "./parse-project-record.js";
import { idToFilename } from "./repo-id.js";

/**
 * Local-mode catalog client. Reads catalogit's per-project YAML layout
 * (one file per project under `<catalogRoot>/projects/<owner>_<slug>.yaml`)
 * and serves the read-only catalog surface.
 *
 * AWS-mode equivalent (`S3Catalog`) reads the bundled `catalog.json` from
 * S3; the `CatalogReadOnly` interface is shared so handlers don't branch
 * on mode.
 *
 * See `data-format.md`.
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
    const { projects, issues } = await collectProjects(options.catalogRoot);
    if (issues.length > 0) {
      throw new CatalogLoadError(issues);
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
  return parseProjectRecord(parsed as Record<string, unknown>, `project YAML at ${source}`);
}

/**
 * Scan `<catalogRoot>/projects/*.yaml`: parse each record, enforce the
 * filename⇄id invariant (data-format.md §Validation — `id` must match the
 * filename), and aggregate a `CatalogLoadIssue` per file that fails parsing,
 * spine validation, or that check, so every bad record is reported at once.
 * Throws `CatalogIoError` (not aggregated) on a directory/file read failure.
 * Shared by `FilesystemCatalog.load` and `validateCatalog`.
 */
export async function collectProjects(
  catalogRoot: string,
): Promise<{ projects: Map<string, Project>; issues: CatalogLoadIssue[]; scanned: number }> {
  const projectsDir = join(catalogRoot, "projects");
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch (err) {
    throw new CatalogIoError({
      source: "local-fs",
      operation: "list",
      path: projectsDir,
      message: `failed to read catalog directory '${projectsDir}': ${errorMessage(err)}`,
      cause: err,
    });
  }

  const projects = new Map<string, Project>();
  const issues: CatalogLoadIssue[] = [];
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    scanned += 1;
    const filePath = join(projectsDir, entry);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      throw new CatalogIoError({
        source: "local-fs",
        operation: "read",
        path: filePath,
        message: `failed to read project file '${filePath}': ${errorMessage(err)}`,
        cause: err,
      });
    }
    let project: Project;
    try {
      project = parseProjectYaml(raw, filePath);
    } catch (err) {
      issues.push({ file: entry, message: errorMessage(err) });
      continue;
    }
    const expected = idToFilename(project.id);
    if (entry !== expected) {
      issues.push({
        file: entry,
        message: `record id '${project.id}' does not match its filename (expected '${expected}')`,
      });
      continue;
    }
    projects.set(project.id, project);
  }
  return { projects, issues, scanned };
}

/**
 * Load and parse a single project file by id, or `undefined` when it doesn't
 * exist. Enforces the filename⇄id invariant: the record's embedded `id` must
 * equal the requested `id` (throws `CatalogLoadError` otherwise). Cheaper than
 * `FilesystemCatalog.load()` when only one record is needed — no full scan.
 */
export async function loadProjectFile(
  catalogRoot: string,
  id: string,
): Promise<Project | undefined> {
  const filename = idToFilename(id);
  const filePath = join(catalogRoot, "projects", filename);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CatalogIoError({
      source: "local-fs",
      operation: "read",
      path: filePath,
      message: `failed to read project file '${filePath}': ${errorMessage(err)}`,
      cause: err,
    });
  }
  let project: Project;
  try {
    project = parseProjectYaml(raw, filePath);
  } catch (err) {
    throw new CatalogLoadError([{ file: filename, message: errorMessage(err) }]);
  }
  if (project.id !== id) {
    throw new CatalogLoadError([
      {
        file: filename,
        message: `record id '${project.id}' does not match the requested id '${id}' (filename⇄id mismatch)`,
      },
    ]);
  }
  return project;
}
