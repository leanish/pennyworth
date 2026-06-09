import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseProjectYaml } from "./filesystem-catalog.js";

/**
 * Spine-check every project YAML under `<catalogRoot>/projects/`. Returns
 * one issue per file that fails parsing or spine validation; an empty
 * array means the catalog is publishable.
 *
 * Used by `catalogit validate` (CLI surface) and the `publish` workflow as
 * a pre-flight check. The implementation mirrors `parseProjectYaml`'s
 * behaviour exactly so "validate" never disagrees with "what `publish`
 * would accept".
 */
export interface CatalogValidationIssue {
  readonly file: string;
  readonly message: string;
}

export interface ValidateCatalogArgs {
  readonly catalogRoot: string;
}

export interface ValidateCatalogResult {
  readonly projectsScanned: number;
  readonly issues: ReadonlyArray<CatalogValidationIssue>;
}

export async function validateCatalog(args: ValidateCatalogArgs): Promise<ValidateCatalogResult> {
  const projectsDir = join(args.catalogRoot, "projects");
  let entries: string[];
  try {
    entries = await readdir(projectsDir);
  } catch (err) {
    return {
      projectsScanned: 0,
      issues: [
        {
          file: projectsDir,
          message: `failed to read directory: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  const issues: CatalogValidationIssue[] = [];
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const filePath = join(projectsDir, entry);
    scanned += 1;
    try {
      const raw = await readFile(filePath, "utf8");
      parseProjectYaml(raw, filePath);
    } catch (err) {
      issues.push({
        file: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { projectsScanned: scanned, issues };
}
