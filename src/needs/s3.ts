import { S3Client as AwsS3Client, GetObjectCommand } from "@aws-sdk/client-s3";

import { awsClientDefaults } from "../aws-mode/client-config.js";
import type {
  GetObjectRequest,
  GetObjectResult,
  S3Client,
} from "../types/clients.js";

import type { NeedSpec } from "./spec.js";

/**
 * `s3` need. Provides `runtime.clients.s3.getObject(...)`. ATC uses this to
 * fetch attachment blobs the consumer uploaded.
 *
 * No required env vars at the runtime level — the bucket and key come from
 * the message's attachment refs. `agent-infra` is what knows the bucket
 * name and grants `s3:GetObject` on its objects.
 */
export const s3Need: NeedSpec<S3Client> = {
  name: "s3",
  envVars: [],
  iamActions: ["s3:GetObject"],
  awsFactory(ctx) {
    const client = new AwsS3Client({
      ...awsClientDefaults(),
      region: ctx.region,
      // Path-style addressing whenever a custom S3 endpoint is in play
      // (LocalStack, MinIO). Real AWS S3 supports both styles, so the
      // override is safe to enable whenever an endpoint override is set.
      ...(process.env["AWS_ENDPOINT_URL"] !== undefined ? { forcePathStyle: true } : {}),
    });
    return {
      async getObject(request: GetObjectRequest): Promise<GetObjectResult> {
        // Debug breadcrumb so the AsyncLocalStorage correlation context
        // (requestId / sourceTrigger / stage) lands on the AWS call in
        // CloudWatch. ConsoleLogger reads getCorrelation() on every emit,
        // so no explicit threading is required here.
        ctx.logger.debug("s3.getObject", { bucket: request.bucket, key: request.key });
        try {
          const result = await client.send(
            new GetObjectCommand({ Bucket: request.bucket, Key: request.key }),
          );
          if (result.Body === undefined) {
            throw new Error(`S3 GetObject ${request.bucket}/${request.key} returned no body`);
          }
          const bytes = await result.Body.transformToByteArray();
          return {
            body: bytes,
            ...(result.ContentType !== undefined ? { contentType: result.ContentType } : {}),
            ...(result.ContentLength !== undefined ? { contentLength: result.ContentLength } : {}),
          };
        } catch (err) {
          ctx.logger.warn("s3.getObject failed", {
            bucket: request.bucket,
            key: request.key,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    };
  },
  localFactory(ctx) {
    return {
      async getObject(request: GetObjectRequest): Promise<GetObjectResult> {
        ctx.logger.warn("local-mode s3.getObject called — returning empty body", {
          bucket: request.bucket,
          key: request.key,
        });
        return { body: new Uint8Array() };
      },
    };
  },
};
