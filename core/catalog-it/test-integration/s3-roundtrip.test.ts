import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";

import { publishCatalog, S3Catalog, type Project } from "../src/index.js";
import {
  createS3TestClient,
  createTestBucket,
  emptyAndDeleteBucket,
  requireLocalStack,
} from "./helpers/localstack.js";

/**
 * Publish → S3Catalog.load round-trip against a real S3 backend. Covers
 * catalogit's publish path end-to-end: bundle serialisation, PutObject,
 * GetObject, parse, snapshot construction, and consumer-scope semantics.
 *
 *   docker compose up -d localstack
 *   cd catalogit && npm run test:integration
 *
 * `requireLocalStack` below throws a clear error if LocalStack isn't
 * reachable — the integration gate fails loudly rather than silently
 * skipping.
 */
describe("catalogit S3 round-trip", () => {
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

  const projects: Project[] = [
    {
      id: "leanish/agent-atc",
      source: { url: "https://github.com/leanish/agent-atc.git", branch: "main" },
      description: "ATC repo",
      extensions: { atc: { enabled: true }, bumpit: { enabled: false } },
    },
    {
      id: "leanish/shared-lib",
      source: { url: "https://github.com/leanish/shared-lib.git", branch: "main" },
      description: "Shared library",
      extensions: { atc: { enabled: true }, bumpit: { enabled: true } },
    },
  ];

  it("publishCatalog writes a bundle that S3Catalog.load reads back", async () => {
    const result = await publishCatalog({ bucket, projects, client });
    expect(result.bucket).toBe(bucket);
    expect(result.key).toBe("catalog.json");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.etag).toBeDefined();

    const catalog = await S3Catalog.load({ bucket, client });
    const all = await catalog.list();
    expect(all.map((p) => p.id).sort()).toEqual(["leanish/agent-atc", "leanish/shared-lib"]);

    const one = await catalog.get("leanish/agent-atc");
    expect(one?.description).toBe("ATC repo");
    expect(one?.source.branch).toBe("main");
  });

  it("forConsumer applies default-on membership against the published bundle", async () => {
    await publishCatalog({ bucket, projects, client });

    const catalog = await S3Catalog.load({ bucket, client });

    // bumpit: only `leanish/shared-lib` has `enabled: true`; `leanish/agent-atc` opted out
    const bumpitScope = await catalog.forConsumer("bumpit").list();
    expect(bumpitScope.map((p) => p.id)).toEqual(["leanish/shared-lib"]);

    // atc: both opted in
    const atcScope = await catalog.forConsumer("atc").list();
    expect(atcScope.map((p) => p.id).sort()).toEqual(["leanish/agent-atc", "leanish/shared-lib"]);
  });

  it("refresh() treats an unchanged remote as a no-op and picks up a re-publish", async () => {
    await publishCatalog({ bucket, projects, client });

    const refreshErrors: unknown[] = [];
    const catalog = await S3Catalog.load({
      bucket,
      client,
      snapshotTtlMs: Infinity,
      onRefreshError: (err) => refreshErrors.push(err),
    });
    expect(catalog.get("leanish/agent-atc")?.description).toBe("ATC repo");

    // Unchanged remote: the conditional GET (IfNoneMatch) must resolve as
    // "not modified", not as a refresh failure — the snapshot survives.
    await catalog.refresh();
    expect(refreshErrors).toEqual([]);
    expect(catalog.get("leanish/agent-atc")?.description).toBe("ATC repo");

    // Changed remote: the next refresh swaps the snapshot atomically.
    await publishCatalog({
      bucket,
      projects: [{ ...projects[0]!, description: "ATC repo v2" }, projects[1]!],
      client,
    });
    await catalog.refresh();
    expect(refreshErrors).toEqual([]);
    expect(catalog.get("leanish/agent-atc")?.description).toBe("ATC repo v2");
  });

  it("re-publishing changes the ETag", async () => {
    const first = await publishCatalog({ bucket, projects, client });
    const second = await publishCatalog({
      bucket,
      projects: [
        ...projects,
        {
          id: "leanish/another",
          source: { url: "https://github.com/leanish/another.git", branch: "main" },
          description: "Added",
          extensions: {},
        },
      ],
      client,
    });
    expect(second.etag).toBeDefined();
    expect(second.etag).not.toBe(first.etag);
  });
});
