import { GetObjectCommand, type S3Client as AwsS3Client } from "@aws-sdk/client-s3";

import type { CatalogReadOnly, ConsumerCatalogView } from "./catalog.js";
import { isEnabledForConsumer } from "./consumer-filter.js";
import type { Project } from "./project.js";
import { CatalogIoError, CatalogLoadError, type CatalogLoadIssue, errorMessage } from "./errors.js";
import { parseProjectRecord } from "./parse-project-record.js";
import { assertNoUnknownKeys, BUNDLE_TOP_LEVEL_KEYS } from "./spine-keys.js";

/**
 * AWS-mode catalog client. Reads the deployed `catalog.json` bundle from
 * S3 (per `data-format.md` §Deployed shape) and serves
 * the read-only catalog surface.
 *
 * **TTL + ETag refresh + stale-fallback** (ported from the codex
 * implementation, 2026-05). The first `load(...)` fetches the bundle
 * eagerly. Subsequent reads serve the cached snapshot for up to
 * `snapshotTtlMs` (default 5 minutes). After the TTL expires, the next
 * read triggers an **asynchronous** refresh that:
 *
 *   - Issues `GetObjectCommand` with `IfNoneMatch: <last-etag>`, so S3
 *     replies 304 (no body transfer) when the bundle hasn't changed.
 *   - On a 304: bumps `loadedAt` to push the next refresh out a TTL.
 *   - On a 200 with a new body: parses + atomically swaps the snapshot.
 *   - On any error (network, S3 5xx, parse failure): **keeps the stale
 *     snapshot** and invokes `onRefreshError(err)` if supplied. Reads
 *     never block on refresh and never throw because of refresh failure;
 *     the only way to observe sustained failure is via the callback.
 *
 * Reads stay synchronous — they always serve the current snapshot,
 * triggering at most one background refresh per call. Concurrent reads
 * coalesce on the same in-flight refresh.
 *
 * To disable refresh entirely (one-shot snapshot, behaviour pre-2026-05),
 * pass `snapshotTtlMs: Infinity`.
 *
 * Snapshot identity is captured at `forConsumer(consumerId)` call time,
 * so the returned `ConsumerCatalogView.list()` / `.get()` are stable
 * relative to that capture even if a refresh swaps the underlying
 * snapshot between successive view-method calls.
 */
export interface S3CatalogOptions {
  readonly bucket: string;
  /** Key for the catalog object. Defaults to `catalog.json`. */
  readonly key?: string;
  readonly client: AwsS3Client;
  /**
   * Background refresh TTL in milliseconds. Default: 5 minutes. Use
   * `Infinity` to disable refresh (one-shot snapshot — the pre-2026-05
   * behaviour). Use a small value in tests to exercise refresh quickly.
   */
  readonly snapshotTtlMs?: number;
  /**
   * Optional callback invoked when a background refresh fails. The
   * stale snapshot is preserved either way — the callback only exists
   * so callers can surface the failure to their structured logger.
   */
  readonly onRefreshError?: (err: unknown) => void;
}

export interface CatalogBundle {
  readonly version: string;
  readonly projects: ReadonlyArray<Project>;
}

const DEFAULT_KEY = "catalog.json";
const DEFAULT_SNAPSHOT_TTL_MS = 5 * 60 * 1000;

interface Snapshot {
  readonly byId: ReadonlyMap<string, Project>;
  readonly list: ReadonlyArray<Project>;
  readonly version: string;
  readonly etag: string | undefined;
  readonly loadedAt: number;
}

export class S3Catalog implements CatalogReadOnly {
  readonly #bucket: string;
  readonly #key: string;
  readonly #client: AwsS3Client;
  readonly #snapshotTtlMs: number;
  readonly #onRefreshError: ((err: unknown) => void) | undefined;
  readonly #now: () => number;

  #snapshot: Snapshot;
  #refreshInFlight: Promise<void> | undefined;

  private constructor(initial: Snapshot, options: S3CatalogOptions, now: () => number = Date.now) {
    this.#snapshot = initial;
    this.#bucket = options.bucket;
    this.#key = options.key ?? DEFAULT_KEY;
    this.#client = options.client;
    this.#snapshotTtlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
    this.#onRefreshError = options.onRefreshError;
    this.#now = now;
  }

  /**
   * Fetch the catalog bundle from S3 and return a ready-to-read
   * `S3Catalog`. Subsequent reads serve the cached snapshot with
   * background-refresh-on-TTL semantics (see the class doc).
   */
  static async load(options: S3CatalogOptions): Promise<S3Catalog> {
    const key = options.key ?? DEFAULT_KEY;
    const uri = `s3://${options.bucket}/${key}`;
    const result = await getCatalogObject(options.client, options.bucket, key, uri);
    if (result.Body === undefined) {
      throw new CatalogIoError({
        source: "s3",
        operation: "get",
        path: uri,
        message: `${uri} returned no body`,
      });
    }
    const raw = await result.Body.transformToString("utf-8");
    const bundle = parseBundle(raw, uri);
    const snapshot: Snapshot = {
      byId: indexById(bundle.projects),
      list: bundle.projects,
      version: bundle.version,
      etag: normaliseEtag(result.ETag),
      loadedAt: Date.now(),
    };
    return new S3Catalog(snapshot, options);
  }

  /**
   * Construct directly from an already-parsed bundle. Visible for tests
   * that need a deterministic clock or want to seed without an S3 round
   * trip. Production code uses `load(...)`.
   */
  static fromBundle(bundle: CatalogBundle, options: S3CatalogOptions & {
    readonly etag?: string;
    readonly now?: () => number;
  }): S3Catalog {
    const now = options.now ?? Date.now;
    return new S3Catalog(
      {
        byId: indexById(bundle.projects),
        list: bundle.projects,
        version: bundle.version,
        etag: options.etag,
        loadedAt: now(),
      },
      options,
      now,
    );
  }

  list(): ReadonlyArray<Project> {
    this.#maybeRefresh();
    return this.#snapshot.list;
  }

  get(id: string): Project | undefined {
    this.#maybeRefresh();
    return this.#snapshot.byId.get(id);
  }

  forConsumer(consumerId: string): ConsumerCatalogView {
    this.#maybeRefresh();
    // Capture the snapshot at view-construction time so the returned
    // view is internally consistent even if a refresh swaps the
    // underlying snapshot before list() / get() are called.
    const snap = this.#snapshot;
    const enabled = snap.list.filter((project) =>
      isEnabledForConsumer(project, consumerId),
    );
    return {
      list: () => enabled,
      get: (id: string) => enabled.find((project) => project.id === id),
    };
  }

  /** Diagnostic — the bundle version (per ADR-0014). */
  get version(): string {
    return this.#snapshot.version;
  }

  /**
   * Force an immediate, awaitable refresh. Returns the in-flight
   * refresh promise if one is already running. Visible primarily for
   * tests and for callers that want to drive refresh on a schedule
   * rather than lazily on reads.
   */
  async refresh(): Promise<void> {
    if (this.#refreshInFlight !== undefined) return this.#refreshInFlight;
    this.#refreshInFlight = this.#doRefresh().finally(() => {
      this.#refreshInFlight = undefined;
    });
    return this.#refreshInFlight;
  }

  #maybeRefresh(): void {
    if (this.#snapshotTtlMs === Infinity) return; // refresh disabled
    if (this.#refreshInFlight !== undefined) return;
    if (this.#now() - this.#snapshot.loadedAt < this.#snapshotTtlMs) return;
    // Kick off background refresh, do NOT await — callers see the stale
    // snapshot until the refresh completes. Errors are surfaced via
    // `onRefreshError`; the read path never throws.
    this.#refreshInFlight = this.#doRefresh().finally(() => {
      this.#refreshInFlight = undefined;
    });
  }

  async #doRefresh(): Promise<void> {
    try {
      const result = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#key,
          ...(this.#snapshot.etag !== undefined ? { IfNoneMatch: this.#snapshot.etag } : {}),
        }),
      );
      if (result.Body === undefined) {
        throw new Error(`S3Catalog: refresh of s3://${this.#bucket}/${this.#key} returned no body`);
      }
      const raw = await result.Body.transformToString("utf-8");
      const bundle = parseBundle(raw, `s3://${this.#bucket}/${this.#key}`);
      this.#snapshot = {
        byId: indexById(bundle.projects),
        list: bundle.projects,
        version: bundle.version,
        etag: normaliseEtag(result.ETag),
        loadedAt: this.#now(),
      };
    } catch (err) {
      // S3 signals "not modified" via a 304 — different SDK versions
      // surface this either as `err.$metadata.httpStatusCode === 304`
      // or as `err.name === "NotModified"`. Treat either as success
      // (the bundle hasn't changed): bump `loadedAt` to defer the next
      // refresh attempt by another TTL, keep the existing snapshot.
      if (isNotModifiedError(err)) {
        this.#snapshot = { ...this.#snapshot, loadedAt: this.#now() };
        return;
      }
      // Real failure: keep the stale snapshot, surface to the caller's
      // logger via the callback. Reads continue to work.
      this.#onRefreshError?.(err);
    }
  }
}

/** Visible for tests. */
export function parseBundle(raw: string, source: string): CatalogBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `S3Catalog: failed to parse JSON at ${source}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`S3Catalog: ${source} is not a JSON object`);
  }
  const value = parsed as Record<string, unknown>;
  assertNoUnknownKeys(value, BUNDLE_TOP_LEVEL_KEYS, {
    locate: `S3Catalog: ${source}`,
    fieldKind: "bundle",
  });
  const version = value["version"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`S3Catalog: ${source} missing 'version'`);
  }
  // Phase 1: only schema "1" is supported (per ADR-0014).
  if (version !== "1") {
    throw new Error(
      `S3Catalog: ${source} has unsupported catalog version '${version}' (this client supports '1')`,
    );
  }
  const projectsRaw = value["projects"];
  if (!Array.isArray(projectsRaw)) {
    throw new Error(`S3Catalog: ${source} missing or non-array 'projects'`);
  }
  const projects: Project[] = [];
  const issues: CatalogLoadIssue[] = [];
  projectsRaw.forEach((p, i) => {
    try {
      projects.push(parseProjectEntry(p, source, i));
    } catch (err) {
      issues.push({ file: `${source}#/projects/${i}`, message: errorMessage(err) });
    }
  });
  if (issues.length > 0) {
    throw new CatalogLoadError(issues);
  }
  return { version, projects };
}

function parseProjectEntry(value: unknown, source: string, index: number): Project {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`S3Catalog: ${source} projects[${index}] is not an object`);
  }
  return parseProjectRecord(
    value as Record<string, unknown>,
    `S3Catalog: ${source} projects[${index}]`,
  );
}

/** GET the bundle object, mapping any S3 transport failure to `CatalogIoError`. */
async function getCatalogObject(
  client: AwsS3Client,
  bucket: string,
  key: string,
  uri: string,
) {
  try {
    return await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    const statusCode = s3StatusCode(err);
    throw new CatalogIoError({
      source: "s3",
      operation: "get",
      path: uri,
      message: `failed to fetch ${uri}: ${errorMessage(err)}`,
      cause: err,
      ...(statusCode !== undefined ? { statusCode } : {}),
    });
  }
}

function s3StatusCode(err: unknown): number | undefined {
  const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return typeof meta?.httpStatusCode === "number" ? meta.httpStatusCode : undefined;
}

function indexById(projects: ReadonlyArray<Project>): ReadonlyMap<string, Project> {
  const map = new Map<string, Project>();
  for (const project of projects) {
    map.set(project.id, project);
  }
  return map;
}

/**
 * S3 quotes ETag values (e.g. `"abc123"`). Strip the quotes so the
 * `IfNoneMatch` round-trip is symmetric — S3 expects the same quoting
 * back, and the SDK adds it for us, but storing the bare value keeps
 * the cache state easy to reason about.
 */
function normaliseEtag(etag: string | undefined): string | undefined {
  if (etag === undefined) return undefined;
  return etag.replaceAll('"', "");
}

function isNotModifiedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (e.name === "NotModified" || e.name === "304") return true;
  if (e.$metadata?.httpStatusCode === 304) return true;
  return false;
}
