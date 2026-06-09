import { rm } from "node:fs/promises";
import { join } from "node:path";

import { GetObjectCommand, type S3Client as AwsS3Client } from "@aws-sdk/client-s3";

import { FilesystemCatalog } from "./filesystem-catalog.js";
import type { Project } from "./project.js";
import { projectFileExists, writeProjectYaml } from "./project-writer.js";
import { writePublishState } from "./publish-state.js";
import { idToFilename } from "./repo-id.js";
import { parseBundle } from "./s3-catalog.js";

export interface PullDeps {
  readonly client: AwsS3Client;
  readonly confirm: (message: string) => Promise<boolean>;
}

export type PruneMode = "ask" | "always" | "never";

export interface PullOptions {
  readonly bucket: string;
  /** Defaults to `catalog.json`. */
  readonly key?: string;
  readonly catalogRoot: string;
  readonly pruneMode: PruneMode;
}

export interface PullSummary {
  readonly etag: string;
  /** ids newly created locally */
  readonly written: readonly string[];
  /** ids that existed and were re-emitted */
  readonly overwritten: readonly string[];
  /** filenames (relative to projects/) of local-only files that were deleted */
  readonly localOnlyDeleted: readonly string[];
  /** filenames (relative to projects/) of local-only files the curator kept */
  readonly localOnlyKept: readonly string[];
}

const DEFAULT_KEY = "catalog.json";

export async function pullCatalog(opts: PullOptions, deps: PullDeps): Promise<PullSummary> {
  const key = opts.key ?? DEFAULT_KEY;

  // Step 1: GET the bundle from S3
  const response = await deps.client.send(
    new GetObjectCommand({ Bucket: opts.bucket, Key: key }),
  );
  if (response.Body === undefined) {
    throw new Error(`pullCatalog: s3://${opts.bucket}/${key} returned no body`);
  }
  const raw = await response.Body.transformToString("utf-8");
  const etag = response.ETag ?? "";

  // Step 2: Parse + validate — throws on any invalid project; nothing written yet
  const bundle = parseBundle(raw, `s3://${opts.bucket}/${key}`);
  const projects: readonly Project[] = bundle.projects;

  // Step 3: Write each project; classify as written (new) or overwritten (existed)
  const written: string[] = [];
  const overwritten: string[] = [];
  for (const project of projects) {
    const existed = await projectFileExists(opts.catalogRoot, project.id);
    await writeProjectYaml(opts.catalogRoot, project);
    if (existed) {
      overwritten.push(project.id);
    } else {
      written.push(project.id);
    }
  }

  // Step 4: Compute local-only ids and act per pruneMode
  const bundleIds = new Set(projects.map((p) => p.id));
  const localOnlyDeleted: string[] = [];
  const localOnlyKept: string[] = [];

  // Load what's currently on disk (includes what we just wrote, but those are in bundleIds)
  const localCatalog = await FilesystemCatalog.load({ catalogRoot: opts.catalogRoot });
  const localIds = localCatalog.list().map((p) => p.id);

  for (const localId of localIds) {
    if (bundleIds.has(localId)) continue;
    const filename = idToFilename(localId);
    const filePath = join(opts.catalogRoot, "projects", filename);
    if (opts.pruneMode === "always") {
      await rm(filePath);
      localOnlyDeleted.push(filename);
    } else if (opts.pruneMode === "never") {
      localOnlyKept.push(filename);
    } else {
      // "ask"
      const shouldDelete = await deps.confirm(`delete local-only ${filename}?`);
      if (shouldDelete) {
        await rm(filePath);
        localOnlyDeleted.push(filename);
      } else {
        localOnlyKept.push(filename);
      }
    }
  }

  // Step 5: Write the conflict-detection baseline for the next publish.
  await writePublishState(opts.catalogRoot, etag);

  return { etag, written, overwritten, localOnlyDeleted, localOnlyKept };
}
