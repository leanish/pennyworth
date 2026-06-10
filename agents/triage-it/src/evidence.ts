import type { Stats } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as tar from "tar";
import type { ReadEntry } from "tar";

/**
 * Safe extraction of the evidence archive (a tar.gz produced by the
 * evidence collector — already customer-scoped + PII-filtered upstream).
 *
 * The archive crosses a trust boundary (it arrives via an S3 URI in a
 * consumer request), so extraction enforces hard caps and rejects every
 * entry kind that could write outside the extraction directory:
 *
 *   - archive size cap (compressed bytes, checked before any parsing)
 *   - entry count cap
 *   - per-entry size cap (from the tar header, checked before extraction)
 *   - no absolute paths, no `..` traversal, no `\` separators, no NUL
 *   - only regular files and directories — symlinks, hardlinks, devices,
 *     FIFOs and every other entry type are rejected
 *   - a `manifest.md` file is required at the archive root (the
 *     collector's map of what's in the bundle)
 *
 * Violations throw `InvalidEvidenceArchiveError`; the handler maps it to a
 * terminal "invalid evidence archive" validation failure. Validation is a
 * separate pass over the entry headers *before* extraction (fail-fast, no
 * partial writes for a rejected archive); the extraction pass re-applies
 * the same checks as a defense-in-depth filter.
 */
export interface EvidenceLimits {
  /** Max compressed archive size in bytes. */
  readonly maxArchiveBytes: number;
  /** Max number of entries (files + directories). */
  readonly maxEntryCount: number;
  /** Max size of a single file entry, in bytes (from the tar header). */
  readonly maxEntryBytes: number;
}

export const EVIDENCE_LIMITS: EvidenceLimits = {
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntryCount: 2000,
  maxEntryBytes: 8 * 1024 * 1024,
};

export const MANIFEST_NAME = "manifest.md";

export class InvalidEvidenceArchiveError extends Error {
  constructor(detail: string) {
    super(`invalid evidence archive: ${detail}`);
    this.name = "InvalidEvidenceArchiveError";
  }
}

export interface ExtractedEvidence {
  /** Directory the archive was extracted into. `manifest.md` sits at its root. */
  readonly evidenceDir: string;
  /** Remove the temp tree (archive + extracted files). The handler calls this in `finally`. */
  readonly cleanup: () => Promise<void>;
}

export interface ExtractEvidenceArchiveArgs {
  /** Raw bytes of the tar.gz archive (as fetched from S3). */
  readonly archive: Uint8Array;
  /** Override the default caps (tests use small values). */
  readonly limits?: EvidenceLimits;
}

/**
 * Validate + extract `archive` into a fresh temp directory.
 *
 * On success the caller owns the returned `cleanup` and must invoke it
 * once the skill run is over (success or failure). On any validation or
 * extraction failure the temp directory is removed before the error
 * propagates — a rejected archive never leaks files.
 */
export async function extractEvidenceArchive(
  args: ExtractEvidenceArchiveArgs,
): Promise<ExtractedEvidence> {
  const limits = args.limits ?? EVIDENCE_LIMITS;

  if (args.archive.byteLength > limits.maxArchiveBytes) {
    throw new InvalidEvidenceArchiveError(
      `archive is ${args.archive.byteLength} bytes; max is ${limits.maxArchiveBytes}`,
    );
  }
  // gzip magic check up front: node-tar's list pass silently yields zero
  // entries for arbitrary non-gzip bytes, which would otherwise surface as
  // a confusing "manifest.md missing" error.
  if (args.archive.byteLength < 2 || args.archive[0] !== 0x1f || args.archive[1] !== 0x8b) {
    throw new InvalidEvidenceArchiveError("not a gzip archive (bad magic bytes)");
  }

  const baseDir = await mkdtemp(join(evidenceTmpDir(), "triage-it-evidence-"));
  try {
    // The archive file lives next to (not inside) the extraction dir so the
    // skill only ever sees the extracted evidence tree.
    const archivePath = join(baseDir, "archive.tgz");
    await writeFile(archivePath, args.archive);
    const evidenceDir = join(baseDir, "evidence");
    await mkdir(evidenceDir);

    validateEntries(archivePath, limits);

    tar.x({
      file: archivePath,
      cwd: evidenceDir,
      sync: true,
      // Defense in depth: validateEntries already vetted every entry; the
      // filter re-applies the same checks so a divergence between the two
      // passes can only ever *skip* an entry, never write an unsafe one.
      // (The `Stats` arm of the filter union belongs to tar's *create*
      // direction; extraction always passes a `ReadEntry`.)
      filter: (_path: string, entry: ReadEntry | Stats) =>
        isReadEntry(entry) && entryViolation(entry, limits) === undefined,
    });

    // The list pass saw a manifest entry; confirm it landed on disk.
    const manifestStat = await stat(join(evidenceDir, MANIFEST_NAME)).catch(() => undefined);
    if (manifestStat === undefined || !manifestStat.isFile()) {
      throw new InvalidEvidenceArchiveError(`${MANIFEST_NAME} was not extracted`);
    }

    return {
      evidenceDir,
      cleanup: () => rm(baseDir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(baseDir, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof InvalidEvidenceArchiveError) throw err;
    // zlib / tar parse failures (corrupt gzip body, truncated tar, …).
    throw new InvalidEvidenceArchiveError(
      `archive could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Header-only validation pass. Throws `InvalidEvidenceArchiveError` on the
 * first violation — fail-fast keeps the work bounded even for archives
 * crafted to decompress far beyond their compressed size.
 */
function validateEntries(archivePath: string, limits: EvidenceLimits): void {
  let count = 0;
  let manifestSeen = false;
  tar.t({
    file: archivePath,
    sync: true,
    onReadEntry: (entry: ReadEntry) => {
      count += 1;
      if (count > limits.maxEntryCount) {
        throw new InvalidEvidenceArchiveError(
          `more than ${limits.maxEntryCount} entries`,
        );
      }
      const violation = entryViolation(entry, limits);
      if (violation !== undefined) {
        throw new InvalidEvidenceArchiveError(violation);
      }
      if (entry.type === "File" && normalizeEntryPath(entry.path) === MANIFEST_NAME) {
        manifestSeen = true;
      }
    },
  });
  if (!manifestSeen) {
    throw new InvalidEvidenceArchiveError(`${MANIFEST_NAME} missing at archive root`);
  }
}

/**
 * Returns a human-readable violation for an unsafe entry, or `undefined`
 * when the entry is safe to extract.
 */
function entryViolation(entry: ReadEntry, limits: EvidenceLimits): string | undefined {
  const path = entry.path;
  if (entry.type !== "File" && entry.type !== "Directory") {
    // Covers symlinks, hardlinks ("Link"), devices, FIFOs, and any other
    // tar entry type — only plain files and directories are extracted.
    return `entry '${path}' has unsupported type '${entry.type}'`;
  }
  if (path.length === 0) return "entry with empty path";
  if (path.includes("\0")) return `entry path contains a NUL byte`;
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
    return `entry '${path}' has an absolute path`;
  }
  if (path.includes("\\")) {
    return `entry '${path}' contains a backslash separator`;
  }
  if (path.split("/").includes("..")) {
    return `entry '${path}' contains a '..' path segment`;
  }
  if ((entry.size ?? 0) > limits.maxEntryBytes) {
    return `entry '${path}' is ${entry.size} bytes; max per file is ${limits.maxEntryBytes}`;
  }
  return undefined;
}

function normalizeEntryPath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function isReadEntry(entry: ReadEntry | Stats): entry is ReadEntry {
  return "header" in entry;
}

/**
 * `os.tmpdir()` resolves to `/tmp` on Lambda (the writable mount) and to
 * the platform's natural temp dir elsewhere. The env override exists for
 * ops scenarios (mounted EFS, scratch on a different volume).
 */
function evidenceTmpDir(): string {
  return process.env["TRIAGE_IT_TMP_DIR"] ?? tmpdir();
}
