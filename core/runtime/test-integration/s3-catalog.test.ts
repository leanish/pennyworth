import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  S3Catalog,
  bundleCatalog,
  publishCatalog,
  type Project,
} from "@leanish/catalog-it";

import { LocalStackHarness } from "../src/testing/localstack-harness.js";

/**
 * End-to-end test for `S3Catalog` against a real S3 bucket. The
 * catalogit `publishCatalog` helper writes a bundle, `S3Catalog.load`
 * reads it back, and consumer-scope semantics behave per ADR-0005.
 *
 * This exercises the only production-required S3 dependency for ATC
 * (catalog reads at cold-start). Failing here = ATC cannot bootstrap.
 *
 * `stack.start()` below throws `LocalStackUnavailableError` if LocalStack
 * isn't reachable — the integration gate fails loudly rather than
 * silently skipping.
 */
describe("S3Catalog against LocalStack", () => {
  const stack = new LocalStackHarness();

  beforeAll(async () => {
    await stack.start();
  });

  afterAll(async () => {
    await stack.stop();
  });

  const projects: Project[] = [
    {
      id: "atc",
      source: { url: "https://github.com/example/atc.git", branch: "main" },
      description: "Ask-the-Code agent",
      extensions: {
        atc: { enabled: true, primaryLanguage: "typescript" },
        reviewit: { enabled: false },
      },
    },
    {
      id: "shared-lib",
      source: { url: "https://github.com/example/shared-lib.git", branch: "main" },
      description: "Shared utilities",
      extensions: {
        atc: { enabled: true },
      },
    },
    {
      id: "reviewer-only",
      source: { url: "https://github.com/example/reviewer-only.git", branch: "main" },
      description: "Reviewit-only; ATC explicitly opted out",
      extensions: {
        reviewit: { enabled: true },
        // Default-on rule (catalogit suite-0008): only `enabled: false`
        // excludes the project from a consumer's view.
        atc: { enabled: false },
      },
    },
  ];

  it("reads a bundle published via publishCatalog", async () => {
    const bucket = await stack.createBucket();
    await publishCatalog({
      bucket,
      key: "catalog.json",
      projects,
      client: stack.s3Client(),
    });

    const catalog = await S3Catalog.load({
      bucket,
      key: "catalog.json",
      client: stack.s3Client(),
    });

    expect(catalog.list()).toHaveLength(3);
    expect(catalog.get("atc")?.description).toBe("Ask-the-Code agent");
    expect(catalog.version).toBe("1");
  });

  it("reads a bundle written by the lower-level bundleCatalog helper", async () => {
    // Some test fixtures bypass publishCatalog and put the body directly.
    // Confirm S3Catalog tolerates this shape (it should — publish just
    // wraps the same bundler + ETag-guarded PutObject).
    const bucket = await stack.createBucket();
    const body = bundleCatalog(projects, {});
    await stack.putObject(bucket, "catalog.json", body, "application/json");

    const catalog = await S3Catalog.load({
      bucket,
      key: "catalog.json",
      client: stack.s3Client(),
    });
    expect(catalog.list().map((p) => p.id).sort()).toEqual(["atc", "reviewer-only", "shared-lib"]);
  });

  it("forConsumer('atc') filters to ATC-enabled projects", async () => {
    const bucket = await stack.createBucket();
    await publishCatalog({
      bucket,
      key: "catalog.json",
      projects,
      client: stack.s3Client(),
    });

    const catalog = await S3Catalog.load({
      bucket,
      key: "catalog.json",
      client: stack.s3Client(),
    });

    const atcView = catalog.forConsumer("atc");
    const atcList = atcView.list();
    // `atc` (enabled: true) + `shared-lib` (default-on, no atc opt-out)
    // — NOT `reviewer-only` (extensions.atc.enabled === false).
    expect(atcList.map((p) => p.id).sort()).toEqual(["atc", "shared-lib"]);

    expect(atcView.get("atc")).toBeDefined();
    expect(atcView.get("reviewer-only")).toBeUndefined();

    // Cross-consumer check — `reviewit` view excludes `atc` (which has
    // extensions.reviewit.enabled === false) but includes `shared-lib`
    // (default-on for any consumer that isn't explicitly opted out).
    const reviewitView = catalog.forConsumer("reviewit");
    expect(reviewitView.list().map((p) => p.id).sort()).toEqual(["reviewer-only", "shared-lib"]);
  });

  it("throws a useful error when the bucket exists but the key is missing", async () => {
    const bucket = await stack.createBucket();
    // Bucket created but no PutObject — the load should surface an S3 NoSuchKey.
    await expect(
      S3Catalog.load({ bucket, key: "missing.json", client: stack.s3Client() }),
    ).rejects.toThrow();
  });

  it("uses 'catalog.json' as the default key when none is specified", async () => {
    const bucket = await stack.createBucket();
    await publishCatalog({
      bucket,
      projects: projects.slice(0, 1),
      client: stack.s3Client(),
    });
    const catalog = await S3Catalog.load({ bucket, client: stack.s3Client() });
    expect(catalog.list()).toHaveLength(1);
  });

  it("refreshes from S3 after the snapshot TTL expires (picks up bundle changes)", async () => {
    const bucket = await stack.createBucket();
    await publishCatalog({ bucket, key: "catalog.json", projects, client: stack.s3Client() });

    // 1ms TTL so any subsequent read triggers refresh.
    const catalog = await S3Catalog.load({
      bucket,
      key: "catalog.json",
      client: stack.s3Client(),
      snapshotTtlMs: 1,
    });
    expect(catalog.list()).toHaveLength(3);

    // Publish a smaller catalog with a different project set
    const trimmed: Project[] = [
      {
        id: "new-only",
        source: { url: "https://example.invalid/new-only.git", branch: "main" },
        description: "Replaced catalog content",
        extensions: { atc: { enabled: true } },
      },
    ];
    await publishCatalog({ bucket, key: "catalog.json", projects: trimmed, client: stack.s3Client() });

    // Tiny pause to ensure TTL elapsed
    await new Promise((resolve) => setTimeout(resolve, 5));
    // First read after TTL serves the OLD snapshot AND triggers refresh
    expect(catalog.list().map((p) => p.id).sort()).toEqual(["atc", "reviewer-only", "shared-lib"]);
    await catalog.refresh(); // wait for the kicked-off refresh
    // After refresh completes, reads see the new snapshot
    expect(catalog.list().map((p) => p.id)).toEqual(["new-only"]);
  });

  it("uses If-None-Match to short-circuit refresh when the bundle is unchanged", async () => {
    const bucket = await stack.createBucket();
    await publishCatalog({ bucket, key: "catalog.json", projects, client: stack.s3Client() });

    // Count GetObject calls via a Proxy over the underlying client.
    const real = stack.s3Client();
    let getObjectCalls = 0;
    const counting = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "send") {
          return (cmd: unknown) => {
            const cmdName = (cmd as { constructor: { name: string } }).constructor.name;
            if (cmdName === "GetObjectCommand") getObjectCalls += 1;
            return (target as unknown as { send: (c: unknown) => Promise<unknown> }).send(cmd);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const catalog = await S3Catalog.load({
      bucket,
      key: "catalog.json",
      client: counting,
      snapshotTtlMs: 1,
    });
    // 1 call so far (the initial load)
    expect(getObjectCalls).toBe(1);

    // Trigger refresh without changing the bundle — S3 should return 304
    // and the snapshot should remain.
    await new Promise((resolve) => setTimeout(resolve, 5));
    catalog.list();
    await catalog.refresh();

    // 2 calls total (initial + the refresh-with-If-None-Match that came back 304)
    expect(getObjectCalls).toBe(2);
    // Snapshot unchanged
    expect(catalog.list()).toHaveLength(3);
  });

  it("keeps the stale snapshot when refresh fails (transient S3 error)", async () => {
    const bucket = await stack.createBucket();
    await publishCatalog({ bucket, key: "catalog.json", projects, client: stack.s3Client() });

    // Build a client whose GetObject calls fail after the initial load.
    const real = stack.s3Client();
    let initialLoadDone = false;
    const flakey = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "send") {
          return (cmd: unknown) => {
            const cmdName = (cmd as { constructor: { name: string } }).constructor.name;
            if (cmdName === "GetObjectCommand" && initialLoadDone) {
              return Promise.reject(new Error("simulated S3 503"));
            }
            return (target as unknown as { send: (c: unknown) => Promise<unknown> })
              .send(cmd)
              .then((r) => {
                if (cmdName === "GetObjectCommand") initialLoadDone = true;
                return r;
              });
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const refreshErrors: unknown[] = [];
    const catalog = await S3Catalog.load({
      bucket,
      key: "catalog.json",
      client: flakey,
      snapshotTtlMs: 1,
      onRefreshError: (err) => refreshErrors.push(err),
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    catalog.list(); // triggers refresh
    await catalog.refresh();

    // Stale snapshot preserved
    expect(catalog.list()).toHaveLength(3);
    // Refresh-error callback fired
    expect(refreshErrors).toHaveLength(1);
    expect((refreshErrors[0] as Error).message).toContain("503");
  });
});
