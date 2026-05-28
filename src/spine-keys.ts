/**
 * The catalog spine's closed key sets — the single source of truth shared by
 * both readers (`FilesystemCatalog`, `S3Catalog`) so the schema can't drift
 * between them. Strict-by-default per ADR-0014: any spine key outside these
 * sets is rejected at load time rather than silently dropped.
 *
 * See `../../../specs/agentic-development/catalogit/docs/adr/0014-spine-versioning.md`.
 */

/** Top-level keys allowed on a project record. */
export const PROJECT_SPINE_KEYS: readonly string[] = ["id", "source", "description", "extensions"];

/** Keys allowed inside the `source` object. */
export const PROJECT_SOURCE_KEYS: readonly string[] = ["url", "branch"];

/** Top-level keys allowed in the deployed `catalog.json` bundle. */
export const BUNDLE_TOP_LEVEL_KEYS: readonly string[] = ["version", "projects"];

/**
 * Reject any key in `obj` not present in `allowed`. The iterate-check-throw
 * structure is shared; the wording varies only by:
 *
 * - `locate` — where the bad key was found (e.g. `project YAML at <path>`
 *   or `S3Catalog: <key> projects[3]`),
 * - `prefix` — `"source."` for nested-object checks, `""` (default) otherwise,
 * - `fieldKind` — `"spine"` (default) or `"bundle"`.
 *
 * Keeping one message template means the readers can't drift on error
 * format either.
 */
export function assertNoUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  ctx: { readonly locate: string; readonly prefix?: string; readonly fieldKind?: "spine" | "bundle" },
): void {
  const prefix = ctx.prefix ?? "";
  const fieldKind = ctx.fieldKind ?? "spine";
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const allowedList = allowed.map((k) => `'${prefix}${k}'`).join(", ");
      throw new Error(
        `${ctx.locate} has unknown ${fieldKind} field '${prefix}${key}' (allowed: ${allowedList})`,
      );
    }
  }
}
