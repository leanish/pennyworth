import {
  PutObjectCommand,
  type S3Client as AwsS3Client,
} from "@aws-sdk/client-s3";

import { bundleCatalog, type BundleOptions } from "./bundle.js";
import type { Project } from "./project.js";

/**
 * Publish a deterministic catalog bundle to `s3://<bucket>/<key>`.
 *
 * Per `../../../specs/agentic-development/catalogit/specs/data-format.md` §Deployed shape, the deployed shape
 * is a single JSON object — one ETag, one atomic publish. `publishCatalog`
 * supports an optional `ifMatch` parameter so a concurrent-edit guard can
 * be wired in by the caller (typically the operator CLI workflow stashes
 * the ETag from the last `pull`).
 *
 * Defaults the object content type to `application/json`. The bucket and
 * key are operator concerns; the runtime never writes the catalog itself.
 */
export interface PublishCatalogArgs {
  readonly bucket: string;
  /** Defaults to `catalog.json`. */
  readonly key?: string;
  readonly projects: ReadonlyArray<Project>;
  readonly client: AwsS3Client;
  /** Optional concurrency guard — pass the ETag returned by the last successful publish or pull. */
  readonly ifMatch?: string;
  /** Override the bundle version (phase 1: `"1"`). */
  readonly bundle?: BundleOptions;
}

export interface PublishCatalogResult {
  readonly bucket: string;
  readonly key: string;
  readonly bytes: number;
  readonly etag?: string;
  readonly versionId?: string;
}

const DEFAULT_KEY = "catalog.json";

export async function publishCatalog(args: PublishCatalogArgs): Promise<PublishCatalogResult> {
  const key = args.key ?? DEFAULT_KEY;
  const body = bundleCatalog(args.projects, args.bundle ?? {});
  const result = await args.client.send(
    new PutObjectCommand({
      Bucket: args.bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
      ...(args.ifMatch !== undefined ? { IfMatch: args.ifMatch } : {}),
    }),
  );
  return {
    bucket: args.bucket,
    key,
    bytes: Buffer.byteLength(body, "utf8"),
    ...(result.ETag !== undefined ? { etag: result.ETag } : {}),
    ...(result.VersionId !== undefined ? { versionId: result.VersionId } : {}),
  };
}
