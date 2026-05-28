import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringify as yamlStringify } from "yaml";

import type { Project } from "./project.js";
import { idToFilename } from "./repo-id.js";

/**
 * Writes a full project record to `<catalogRoot>/projects/<owner>_<slug>.yaml`.
 *
 * Field order follows the documented spine order: `id`, `source`, `extensions`,
 * `description`. Optional fields (`extensions` when empty, `description`) are
 * omitted when absent, matching the behaviour of `bundle.ts`.
 */
export async function writeProjectYaml(catalogRoot: string, project: Project): Promise<void> {
  const projectsDir = join(catalogRoot, "projects");
  await mkdir(projectsDir, { recursive: true });

  const out: Record<string, unknown> = {
    id: project.id,
    source: { url: project.source.url, branch: project.source.branch },
  };
  const extensionKeys = Object.keys(project.extensions);
  if (extensionKeys.length > 0) {
    out["extensions"] = project.extensions;
  }
  if (project.description !== undefined) {
    out["description"] = project.description;
  }

  const filename = idToFilename(project.id);
  await writeFile(join(projectsDir, filename), yamlStringify(out), "utf8");
}

/**
 * Writes a minimal skeleton record containing only `id` and `source.url`.
 *
 * `branch`, `extensions`, and `description` are intentionally omitted: the
 * loader defaults `branch` to `"main"`, absent `extensions` means opted-in
 * to all consumers, and absent `description` means no prose yet.
 */
export async function writeSkeleton(
  catalogRoot: string,
  id: string,
  sourceUrl: string,
): Promise<void> {
  const projectsDir = join(catalogRoot, "projects");
  await mkdir(projectsDir, { recursive: true });

  const out: Record<string, unknown> = {
    id,
    source: { url: sourceUrl },
  };

  const filename = idToFilename(id);
  await writeFile(join(projectsDir, filename), yamlStringify(out), "utf8");
}

/**
 * Returns `true` when the per-project YAML file for `id` already exists under
 * `<catalogRoot>/projects/`.
 */
export async function projectFileExists(catalogRoot: string, id: string): Promise<boolean> {
  const filePath = join(catalogRoot, "projects", idToFilename(id));
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
