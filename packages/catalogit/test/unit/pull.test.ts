import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { pullCatalog } from "../../src/pull.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const PROJECT_A = {
  id: "leanish/alpha",
  source: { url: "https://github.com/leanish/alpha.git", branch: "main" },
  extensions: {},
};

const PROJECT_B = {
  id: "leanish/bravo",
  source: { url: "https://github.com/leanish/bravo.git", branch: "main" },
  extensions: {},
};

const PROJECT_C_YAML = [
  "id: leanish/charlie",
  "source:",
  "  url: https://github.com/leanish/charlie.git",
  "  branch: main",
  "",
].join("\n");

function makeBundle(projects: unknown[]): string {
  return JSON.stringify({ version: "1", projects });
}

function fakeS3Client(body: string, etag: string): S3Client {
  const client = new S3Client({ region: "us-east-1" });
  vi.spyOn(client, "send").mockImplementation(async (cmd) => {
    if (cmd instanceof GetObjectCommand) {
      // Mirror the pattern from s3-catalog-refresh.test.ts: supply a minimal
      // Body stub with `transformToString()` instead of a real SDK stream.
      return {
        Body: { transformToString: () => Promise.resolve(body) },
        ETag: etag,
      };
    }
    throw new Error("unexpected command");
  });
  return client;
}

async function makeCatalogRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "catalogit-pull-test-"));
  await mkdir(join(root, "projects"), { recursive: true });
  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pullCatalog", () => {
  it("happy path: writes new projects and state file", async () => {
    const catalogRoot = await makeCatalogRoot();
    const bundle = makeBundle([PROJECT_A, PROJECT_B]);
    const client = fakeS3Client(bundle, '"abc123"');
    const confirm = vi.fn<() => Promise<boolean>>();

    const summary = await pullCatalog(
      { bucket: "my-bucket", catalogRoot, pruneMode: "never" },
      { client, confirm },
    );

    expect(summary.written).toEqual(["leanish/alpha", "leanish/bravo"]);
    expect(summary.overwritten).toEqual([]);
    expect(summary.localOnlyDeleted).toEqual([]);
    expect(summary.localOnlyKept).toEqual([]);
    expect(summary.etag).toBe('"abc123"');

    // YAMLs written on disk
    const alphaPath = join(catalogRoot, "projects", "leanish_alpha.yaml");
    const bravoPath = join(catalogRoot, "projects", "leanish_bravo.yaml");
    await expect(stat(alphaPath)).resolves.not.toThrow();
    await expect(stat(bravoPath)).resolves.not.toThrow();

    // State file written with the ETag
    const stateRaw = await readFile(join(catalogRoot, ".catalogit-state.json"), "utf8");
    const state = JSON.parse(stateRaw) as { etag: string };
    expect(state.etag).toBe('"abc123"');
  });

  it("overwrite: existing YAML is updated to bundle content", async () => {
    const catalogRoot = await makeCatalogRoot();

    // Pre-write alpha with a different description
    await writeFile(
      join(catalogRoot, "projects", "leanish_alpha.yaml"),
      [
        "id: leanish/alpha",
        "source:",
        "  url: https://github.com/leanish/alpha.git",
        "  branch: main",
        "description: old description",
        "",
      ].join("\n"),
      "utf8",
    );

    const bundleAlpha = { ...PROJECT_A, description: "new description" };
    const bundle = makeBundle([bundleAlpha]);
    const client = fakeS3Client(bundle, '"etag-overwrite"');
    const confirm = vi.fn<() => Promise<boolean>>();

    const summary = await pullCatalog(
      { bucket: "my-bucket", catalogRoot, pruneMode: "never" },
      { client, confirm },
    );

    expect(summary.written).toEqual([]);
    expect(summary.overwritten).toEqual(["leanish/alpha"]);

    // Disk content matches bundle (description updated)
    const text = await readFile(
      join(catalogRoot, "projects", "leanish_alpha.yaml"),
      "utf8",
    );
    expect(text).toContain("new description");
    expect(text).not.toContain("old description");
  });

  it("local-only, ask + confirm true: deletes the local-only file", async () => {
    const catalogRoot = await makeCatalogRoot();

    // Pre-write charlie (not in bundle)
    await writeFile(join(catalogRoot, "projects", "leanish_charlie.yaml"), PROJECT_C_YAML, "utf8");

    const bundle = makeBundle([PROJECT_A]);
    const client = fakeS3Client(bundle, '"etag-ask-true"');
    const confirm = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    const summary = await pullCatalog(
      { bucket: "my-bucket", catalogRoot, pruneMode: "ask" },
      { client, confirm },
    );

    expect(summary.localOnlyDeleted).toEqual(["leanish_charlie.yaml"]);
    expect(summary.localOnlyKept).toEqual([]);
    expect(confirm).toHaveBeenCalledOnce();

    // File deleted
    await expect(stat(join(catalogRoot, "projects", "leanish_charlie.yaml"))).rejects.toThrow();
  });

  it("local-only, ask + confirm false: keeps the local-only file", async () => {
    const catalogRoot = await makeCatalogRoot();

    await writeFile(join(catalogRoot, "projects", "leanish_charlie.yaml"), PROJECT_C_YAML, "utf8");

    const bundle = makeBundle([PROJECT_A]);
    const client = fakeS3Client(bundle, '"etag-ask-false"');
    const confirm = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    const summary = await pullCatalog(
      { bucket: "my-bucket", catalogRoot, pruneMode: "ask" },
      { client, confirm },
    );

    expect(summary.localOnlyDeleted).toEqual([]);
    expect(summary.localOnlyKept).toEqual(["leanish_charlie.yaml"]);
    expect(confirm).toHaveBeenCalledOnce();

    // File still on disk
    await expect(stat(join(catalogRoot, "projects", "leanish_charlie.yaml"))).resolves.not.toThrow();
  });

  it("local-only, always: deletes without calling confirm", async () => {
    const catalogRoot = await makeCatalogRoot();

    await writeFile(join(catalogRoot, "projects", "leanish_charlie.yaml"), PROJECT_C_YAML, "utf8");

    const bundle = makeBundle([PROJECT_A]);
    const client = fakeS3Client(bundle, '"etag-always"');
    const confirm = vi.fn<() => Promise<boolean>>();

    const summary = await pullCatalog(
      { bucket: "my-bucket", catalogRoot, pruneMode: "always" },
      { client, confirm },
    );

    expect(summary.localOnlyDeleted).toEqual(["leanish_charlie.yaml"]);
    expect(confirm).not.toHaveBeenCalled();

    await expect(stat(join(catalogRoot, "projects", "leanish_charlie.yaml"))).rejects.toThrow();
  });

  it("local-only, never: keeps without calling confirm", async () => {
    const catalogRoot = await makeCatalogRoot();

    await writeFile(join(catalogRoot, "projects", "leanish_charlie.yaml"), PROJECT_C_YAML, "utf8");

    const bundle = makeBundle([PROJECT_A]);
    const client = fakeS3Client(bundle, '"etag-never"');
    const confirm = vi.fn<() => Promise<boolean>>();

    const summary = await pullCatalog(
      { bucket: "my-bucket", catalogRoot, pruneMode: "never" },
      { client, confirm },
    );

    expect(summary.localOnlyDeleted).toEqual([]);
    expect(summary.localOnlyKept).toEqual(["leanish_charlie.yaml"]);
    expect(confirm).not.toHaveBeenCalled();

    await expect(stat(join(catalogRoot, "projects", "leanish_charlie.yaml"))).resolves.not.toThrow();
  });

  it("invalid bundle: throws, no YAMLs written, no state file", async () => {
    const catalogRoot = await makeCatalogRoot();

    // Bundle with a project missing source.url — parseBundle will throw
    const badBundle = JSON.stringify({
      version: "1",
      projects: [{ id: "leanish/bad", source: {} }],
    });
    const client = fakeS3Client(badBundle, '"etag-bad"');
    const confirm = vi.fn<() => Promise<boolean>>();

    await expect(
      pullCatalog({ bucket: "my-bucket", catalogRoot, pruneMode: "never" }, { client, confirm }),
    ).rejects.toThrow(/source\.url missing/);

    // No YAML written
    const entries = await readdir(join(catalogRoot, "projects"));
    expect(entries).toHaveLength(0);

    // No state file
    await expect(stat(join(catalogRoot, ".catalogit-state.json"))).rejects.toThrow();
  });

  it("state file contains the raw ETag from S3", async () => {
    const catalogRoot = await makeCatalogRoot();
    const bundle = makeBundle([PROJECT_A]);
    // S3 returns ETags with surrounding quotes
    const client = fakeS3Client(bundle, '"deadbeef-etag"');
    const confirm = vi.fn<() => Promise<boolean>>();

    const summary = await pullCatalog(
      { bucket: "my-bucket", catalogRoot, pruneMode: "never" },
      { client, confirm },
    );

    expect(summary.etag).toBe('"deadbeef-etag"');
    const stateRaw = await readFile(join(catalogRoot, ".catalogit-state.json"), "utf8");
    const state = JSON.parse(stateRaw) as { etag: string };
    expect(state.etag).toBe('"deadbeef-etag"');
    // State file ends with a trailing newline
    expect(stateRaw.endsWith("\n")).toBe(true);
  });
});

// Need this import for the invalid-bundle test
async function readdir(dir: string): Promise<string[]> {
  const { readdir: fsReaddir } = await import("node:fs/promises");
  return fsReaddir(dir);
}
