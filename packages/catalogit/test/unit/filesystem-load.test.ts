import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { CatalogLoadError } from "../../src/errors.js";
import { FilesystemCatalog, loadProjectFile } from "../../src/filesystem-catalog.js";

async function writeProjectsDir(root: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, "projects");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
}

function recordYaml(id: string, url = "https://github.com/leanish/x.git"): string {
  return `id: ${id}\nsource:\n  url: ${url}\n`;
}

/** Capture a rejection as a value (avoids expect.unreachable). */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (err: unknown) => err,
  );
}

describe("FilesystemCatalog.load — filename⇄id + typed errors", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "catit-load-"));
  });

  it("throws CatalogLoadError when a file's embedded id does not match its filename", async () => {
    // File named leanish_foo.yaml but content says id: other/bar.
    await writeProjectsDir(root, { "leanish_foo.yaml": recordYaml("other/bar") });
    const err = await rejection(FilesystemCatalog.load({ catalogRoot: root }));
    expect(err).toBeInstanceOf(CatalogLoadError);
    const issues = (err as CatalogLoadError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.file).toBe("leanish_foo.yaml");
    expect(issues[0]!.message).toMatch(/does not match its filename/);
  });

  it("aggregates every bad record across files (not one-at-a-time)", async () => {
    await writeProjectsDir(root, {
      "leanish_foo.yaml": recordYaml("other/bar"), // filename⇄id mismatch
      "leanish_baz.yaml": "id: leanish/baz\nsource: {}\n", // missing source.url
      "leanish_ok.yaml": recordYaml("leanish/ok"), // valid
    });
    const err = await rejection(FilesystemCatalog.load({ catalogRoot: root }));
    expect(err).toBeInstanceOf(CatalogLoadError);
    expect((err as CatalogLoadError).issues).toHaveLength(2);
  });

  it("loads cleanly when every filename matches its id", async () => {
    await writeProjectsDir(root, { "leanish_ok.yaml": recordYaml("leanish/ok") });
    const catalog = await FilesystemCatalog.load({ catalogRoot: root });
    expect(catalog.get("leanish/ok")?.id).toBe("leanish/ok");
  });

  it("throws CatalogIoError when the projects directory is missing", async () => {
    const err = await rejection(FilesystemCatalog.load({ catalogRoot: root }));
    expect(err).toMatchObject({ name: "CatalogIoError", source: "local-fs", operation: "list" });
  });

  it("loadProjectFile throws CatalogLoadError on a filename⇄id mismatch", async () => {
    await writeProjectsDir(root, { "leanish_foo.yaml": recordYaml("other/bar") });
    const err = await rejection(loadProjectFile(root, "leanish/foo"));
    expect(err).toBeInstanceOf(CatalogLoadError);
  });

  it("loadProjectFile returns undefined for a missing file", async () => {
    await writeProjectsDir(root, {});
    await expect(loadProjectFile(root, "leanish/missing")).resolves.toBeUndefined();
  });
});
