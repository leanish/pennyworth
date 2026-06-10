import { CatalogIoError } from "./errors.js";
import { collectProjects } from "./filesystem-catalog.js";

/**
 * Spine-check every project YAML under `<catalogRoot>/projects/`. Returns one
 * issue per file that fails parsing, spine validation, or the filename⇄id
 * invariant; an empty array means the catalog is publishable.
 *
 * Used by `catalogit validate` (CLI surface) and the `publish` workflow as a
 * pre-flight check. Delegates to the same `collectProjects` scan that
 * `FilesystemCatalog.load` uses, so "validate" never disagrees with "what
 * `publish` would accept". A directory-level I/O failure is reported as a
 * single issue (collect-and-report — `validate` never throws for a bad root).
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
  try {
    const { issues, scanned } = await collectProjects(args.catalogRoot);
    return { projectsScanned: scanned, issues };
  } catch (err) {
    if (err instanceof CatalogIoError) {
      return {
        projectsScanned: 0,
        issues: [{ file: err.path ?? args.catalogRoot, message: err.message }],
      };
    }
    throw err;
  }
}
