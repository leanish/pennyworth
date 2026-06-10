import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";

import { publishCatalog, type Project } from "../src/index.js";
import {
  createS3TestClient,
  createTestBucket,
  emptyAndDeleteBucket,
  requireLocalStack,
} from "./helpers/localstack.js";

/**
 * Exercises catalogit's concurrent-edit guard against a real S3 backend.
 * The curator workflow is: `pull` captures the bundle's ETag, the curator
 * edits, then `publish --if-match <etag>` rejects if anyone else published
 * in the window. The unit tests assert that the `ifMatch` argument flows
 * through to `PutObjectCommand.IfMatch`; this test confirms S3 itself
 * actually enforces the precondition.
 *
 * `requireLocalStack` below throws a clear error if LocalStack isn't
 * reachable — the integration gate fails loudly rather than silently
 * skipping.
 */
describe("catalogit publish ifMatch concurrency guard", () => {
  let client: S3Client;
  let bucket: string;

  beforeAll(async () => {
    await requireLocalStack();
    client = createS3TestClient();
    bucket = await createTestBucket(client);
  });

  afterAll(async () => {
    if (bucket !== undefined) {
      await emptyAndDeleteBucket(client, bucket);
    }
    client?.destroy();
  });

  // Each test uses content variations so S3 ETags actually advance —
  // identical bytes produce identical ETags (S3 ETag = content hash for
  // single-part PutObject), which would defeat the staleness scenarios.
  const project = (description: string): Project => ({
    id: "leanish/agent-atc",
    source: { url: "https://github.com/leanish/agent-atc.git", branch: "main" },
    description,
    extensions: { atc: { enabled: true } },
  });

  it("rejects a publish with a stale ifMatch ETag", async () => {
    // Curator A's last successful publish captured E1.
    const a1 = await publishCatalog({ bucket, projects: [project("v1")], client });
    const e1 = a1.etag;
    if (e1 === undefined) {
      throw new Error("LocalStack returned no ETag on PutObject — harness broken");
    }

    // Curator B sneaks in a publish — bucket ETag advances to E2.
    const b = await publishCatalog({ bucket, projects: [project("v2-by-B")], client });
    expect(b.etag).not.toBe(e1);

    // Curator A attempts `publish --if-match E1` with their edit. E1 is now stale.
    await expect(
      publishCatalog({
        bucket,
        projects: [project("v3-by-A")],
        client,
        ifMatch: e1,
      }),
    ).rejects.toThrow(/PreconditionFailed|If-Match|pre.?condition/i);
  });

  it("accepts a publish with the current ifMatch ETag", async () => {
    const initial = await publishCatalog({ bucket, projects: [project("fresh-1")], client });
    const e1 = initial.etag;
    if (e1 === undefined) {
      throw new Error("LocalStack returned no ETag on PutObject — harness broken");
    }

    // No one else publishes in between — E1 is still current. Different bytes
    // this time so the new ETag is genuinely distinct (not just equal-by-content).
    const next = await publishCatalog({
      bucket,
      projects: [project("fresh-2")],
      client,
      ifMatch: e1,
    });
    expect(next.etag).toBeDefined();
    expect(next.etag).not.toBe(e1);
  });
});
