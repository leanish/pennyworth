import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * Minimal LocalStack helper for catalog-it's S3-backed integration tests.
 *
 * Why not import `runtime`'s `LocalStackHarness`? `runtime`
 * depends on `catalog-it` (file:../catalog-it) — pulling its testing
 * surface in here would invert the dependency edge. catalog-it needs S3
 * only; the helper stays tiny enough that duplication is the right call.
 *
 * The harness exposes the bare minimum: reachability probe, S3 client
 * configured for LocalStack's path-style addressing + dummy credentials,
 * and create/teardown for one bucket per test file.
 */

const DEFAULT_ENDPOINT = "http://localhost:4566";

/** Resolve the LocalStack endpoint URL from `$LOCALSTACK_HOST` or the default. */
export function localStackEndpoint(): string {
  const envHost = process.env["LOCALSTACK_HOST"];
  return envHost !== undefined ? `http://${envHost}` : DEFAULT_ENDPOINT;
}

/**
 * Test-side precondition for catalog-it's LocalStack-backed integration
 * suite. Throws a clear, actionable error if LocalStack isn't reachable
 * so the gate fails loudly. Wire from `beforeAll`:
 *
 *   beforeAll(requireLocalStack);
 *
 * catalog-it can't import `runtime`'s harness (would invert the
 * dependency edge), so this lives here.
 */
export async function requireLocalStack(): Promise<void> {
  const url = `${localStackEndpoint()}/_localstack/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    if (response.ok) return;
  } catch {
    // fall through to throw
  }
  throw new Error(
    `LocalStack not reachable at ${localStackEndpoint()}. ` +
      "Run `docker compose up -d localstack` from the agentic-development/ root.",
  );
}

/**
 * Build an S3 client pointed at LocalStack. LocalStack S3 requires
 * `forcePathStyle: true` (no virtual-host-style URLs on localhost) and
 * accepts any non-empty credential pair.
 */
export function createS3TestClient(): S3Client {
  return new S3Client({
    endpoint: localStackEndpoint(),
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

/**
 * Create a uniquely-named bucket for a test. Caller is responsible for
 * cleanup via {@link emptyAndDeleteBucket}.
 */
export async function createTestBucket(client: S3Client): Promise<string> {
  const name = `catalog-it-test-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  await client.send(new CreateBucketCommand({ Bucket: name }));
  return name;
}

/**
 * Delete every object in the bucket, then the bucket itself. Safe to
 * call against a non-existent bucket (errors are swallowed); the goal
 * is best-effort teardown in `afterAll` hooks.
 */
export async function emptyAndDeleteBucket(client: S3Client, name: string): Promise<void> {
  try {
    let continuationToken: string | undefined;
    do {
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: name,
          ...(continuationToken !== undefined ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const obj of result.Contents ?? []) {
        if (obj.Key !== undefined) {
          await client.send(new DeleteObjectCommand({ Bucket: name, Key: obj.Key }));
        }
      }
      continuationToken = result.IsTruncated === true ? result.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);
    await client.send(new DeleteBucketCommand({ Bucket: name }));
  } catch {
    // Best-effort teardown — leftovers in LocalStack die with the container.
  }
}
