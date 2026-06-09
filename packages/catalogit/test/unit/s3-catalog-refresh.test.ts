import { describe, expect, it, vi } from "vitest";

import { S3Catalog, type CatalogBundle } from "../../src/index.js";

/**
 * Unit-level coverage for the S3Catalog TTL + ETag + stale-fallback
 * refresh design (ported from the codex implementation, 2026-05).
 *
 * The integration test in `agent-runtime/test-integration/s3-catalog.test.ts`
 * exercises the same shape against real LocalStack S3 (real 304 + real
 * cache invalidation). These tests give offline coverage of the
 * read-path semantics via a mock `S3Client` so we have meaningful
 * coverage when Docker isn't running.
 */
describe("S3Catalog refresh", () => {
  const bucket = "test-bucket";
  const key = "catalog.json";

  function bundleOf(...ids: string[]): CatalogBundle {
    return {
      version: "1",
      projects: ids.map((id) => ({
        id,
        source: { url: `https://example.invalid/${id}.git`, branch: "main" },
        extensions: { atc: { enabled: true } },
      })),
    };
  }

  function mockS3(handler: (input: { Bucket?: string; Key?: string; IfNoneMatch?: string }) => unknown) {
    const send = vi.fn(async (cmd: unknown) => {
      const input = (cmd as { input: { Bucket?: string; Key?: string; IfNoneMatch?: string } }).input;
      return handler(input);
    });
    return { client: { send } as never, send };
  }

  it("serves the cached snapshot for reads inside the TTL window (no S3 call)", async () => {
    const { client, send } = mockS3(() => {
      throw new Error("no refresh expected inside TTL window");
    });
    let nowMs = 1_000;
    const catalog = S3Catalog.fromBundle(bundleOf("a", "b"), {
      bucket,
      key,
      client,
      etag: "v1",
      snapshotTtlMs: 60_000,
      now: () => nowMs,
    });

    nowMs += 5_000; // well within TTL
    expect(catalog.list().map((p) => p.id)).toEqual(["a", "b"]);
    expect(catalog.get("a")?.id).toBe("a");
    expect(send).not.toHaveBeenCalled();
  });

  it("kicks off a background refresh after the TTL expires", async () => {
    const { client, send } = mockS3(() => ({
      Body: {
        transformToString: () => Promise.resolve(JSON.stringify(bundleOf("a", "b", "c"))),
      },
      ETag: '"v2"',
    }));
    let nowMs = 1_000;
    const catalog = S3Catalog.fromBundle(bundleOf("a", "b"), {
      bucket,
      key,
      client,
      etag: "v1",
      snapshotTtlMs: 500,
      now: () => nowMs,
    });

    // First read inside TTL — cached, no refresh
    expect(catalog.list().map((p) => p.id)).toEqual(["a", "b"]);
    expect(send).not.toHaveBeenCalled();

    // Advance past TTL
    nowMs += 1_000;
    // Read serves stale snapshot AND triggers background refresh
    expect(catalog.list().map((p) => p.id)).toEqual(["a", "b"]);
    // Refresh is in-flight; awaiting it via the catalog's `refresh()` method
    // returns the same in-flight Promise
    await catalog.refresh();

    // Next read sees the refreshed snapshot
    expect(catalog.list().map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends If-None-Match with the cached ETag and serves the cached snapshot on 304", async () => {
    let observedIfNoneMatch: string | undefined;
    const { client, send } = mockS3((input) => {
      observedIfNoneMatch = input.IfNoneMatch;
      const err = new Error("Not Modified");
      (err as unknown as { name: string }).name = "NotModified";
      (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = {
        httpStatusCode: 304,
      };
      throw err;
    });
    let nowMs = 1_000;
    const catalog = S3Catalog.fromBundle(bundleOf("a"), {
      bucket,
      key,
      client,
      etag: "v1",
      snapshotTtlMs: 500,
      now: () => nowMs,
    });

    nowMs += 1_000;
    catalog.list(); // trigger refresh
    await catalog.refresh();

    expect(observedIfNoneMatch).toBe("v1");
    // Snapshot unchanged after 304
    expect(catalog.list().map((p) => p.id)).toEqual(["a"]);
    expect(send).toHaveBeenCalledTimes(1);

    // A second read past TTL doesn't immediately re-refresh — loadedAt
    // got bumped on the 304.
    nowMs += 200;
    catalog.list();
    expect(send).toHaveBeenCalledTimes(1);

    // Now go past TTL again — should refresh once more
    nowMs += 1_000;
    catalog.list();
    await catalog.refresh();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("serves the stale snapshot when refresh fails, and invokes onRefreshError", async () => {
    const refreshErrors: unknown[] = [];
    const { client } = mockS3(() => {
      throw new Error("S3 transient 503");
    });
    let nowMs = 1_000;
    const catalog = S3Catalog.fromBundle(bundleOf("a", "b"), {
      bucket,
      key,
      client,
      etag: "v1",
      snapshotTtlMs: 500,
      now: () => nowMs,
      onRefreshError: (err) => refreshErrors.push(err),
    });

    nowMs += 1_000;
    catalog.list(); // trigger background refresh
    await catalog.refresh();

    // Stale snapshot preserved
    expect(catalog.list().map((p) => p.id)).toEqual(["a", "b"]);
    // Callback fired with the underlying error
    expect(refreshErrors).toHaveLength(1);
    expect((refreshErrors[0] as Error).message).toBe("S3 transient 503");
  });

  it("coalesces concurrent reads onto a single in-flight refresh", async () => {
    let resolveBody: (body: string) => void = () => undefined;
    const bodyPromise = new Promise<string>((resolve) => {
      resolveBody = resolve;
    });
    const { client, send } = mockS3(() => ({
      Body: { transformToString: () => bodyPromise },
      ETag: '"v2"',
    }));
    let nowMs = 1_000;
    const catalog = S3Catalog.fromBundle(bundleOf("a"), {
      bucket,
      key,
      client,
      etag: "v1",
      snapshotTtlMs: 500,
      now: () => nowMs,
    });

    nowMs += 1_000;
    // Multiple reads while refresh is in flight — only one S3 call
    catalog.list();
    catalog.list();
    catalog.list();
    catalog.get("a");
    expect(send).toHaveBeenCalledTimes(1);

    resolveBody(JSON.stringify(bundleOf("a", "b")));
    await catalog.refresh();
    expect(catalog.list().map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("disables refresh entirely when snapshotTtlMs is Infinity (legacy one-shot)", async () => {
    const { client, send } = mockS3(() => {
      throw new Error("refresh disabled — should not be called");
    });
    let nowMs = 1_000;
    const catalog = S3Catalog.fromBundle(bundleOf("a"), {
      bucket,
      key,
      client,
      etag: "v1",
      snapshotTtlMs: Infinity,
      now: () => nowMs,
    });

    nowMs += 10 * 60 * 60 * 1000; // 10 hours
    catalog.list();
    catalog.get("a");
    catalog.forConsumer("atc").list();
    expect(send).not.toHaveBeenCalled();
  });

  it("forConsumer view stays internally consistent across a snapshot swap", async () => {
    const { client } = mockS3(() => ({
      Body: { transformToString: () => Promise.resolve(JSON.stringify(bundleOf("z"))) },
      ETag: '"v2"',
    }));
    let nowMs = 1_000;
    const catalog = S3Catalog.fromBundle(bundleOf("a", "b"), {
      bucket,
      key,
      client,
      etag: "v1",
      snapshotTtlMs: 500,
      now: () => nowMs,
    });

    nowMs += 1_000;
    // Capture a view BEFORE refresh completes
    const view = catalog.forConsumer("atc");
    await catalog.refresh();
    // The view captured the pre-refresh snapshot — still sees a, b
    expect(view.list().map((p) => p.id)).toEqual(["a", "b"]);
    // A fresh view sees the post-refresh snapshot
    expect(catalog.forConsumer("atc").list().map((p) => p.id)).toEqual(["z"]);
  });
});
