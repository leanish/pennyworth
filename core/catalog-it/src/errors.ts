/**
 * Structured errors for catalog loading (per `library-api.md` §Errors).
 *
 * Callers branch on the stable `name` string — `instanceof` is unreliable
 * across bundlers or duplicated module instances — so the runtime `name` is
 * set explicitly on each subclass.
 *
 * Only `load(...)` / `refresh()` perform I/O and can throw these; the
 * synchronous `list()` / `get(...)` reads serve from an in-memory snapshot.
 */

export interface CatalogLoadIssue {
  /** Catalog-root-relative file for local; synthetic `<source>#/projects/<i>` for bundle mode. */
  readonly file: string;
  /** YAML line number, when known. */
  readonly line?: number;
  /** RFC 6901 JSON Pointer into the parsed record, when known. */
  readonly pointer?: string;
  /** Short, human-readable; safe to display on a single CLI line. */
  readonly message: string;
}

/**
 * Thrown when one or more project records fail spine validation. `issues`
 * aggregates every failure found so curators see all bad records at once
 * (never empty).
 */
export class CatalogLoadError extends Error {
  readonly issues: readonly CatalogLoadIssue[];

  constructor(issues: readonly CatalogLoadIssue[]) {
    if (issues.length === 0) {
      throw new Error("CatalogLoadError requires at least one issue");
    }
    const summary =
      issues.length === 1
        ? `${issues[0]!.file}: ${issues[0]!.message}`
        : `${issues.length} records failed validation`;
    super(`catalog validation failed: ${summary}`);
    this.name = "CatalogLoadError";
    this.issues = issues;
  }
}

/** Thrown for underlying I/O failures (filesystem, S3) that are NOT validation failures. */
export class CatalogIoError extends Error {
  readonly source: "local-fs" | "s3";
  readonly operation: string;
  readonly path?: string;
  readonly statusCode?: number;

  constructor(args: {
    readonly source: "local-fs" | "s3";
    readonly operation: string;
    readonly message: string;
    readonly path?: string;
    readonly statusCode?: number;
    readonly cause?: unknown;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = "CatalogIoError";
    this.source = args.source;
    this.operation = args.operation;
    if (args.path !== undefined) this.path = args.path;
    if (args.statusCode !== undefined) this.statusCode = args.statusCode;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
