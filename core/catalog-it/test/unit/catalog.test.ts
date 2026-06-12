import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FilesystemCatalog,
  InMemoryCatalog,
  isEnabledForConsumer,
  type Project,
} from "../../src/index.js";

const ATC_PROJECT: Project = {
  id: "leanish/atc",
  source: { url: "https://github.com/leanish/atc.git", branch: "main" },
  extensions: { atc: { enabled: true }, bumpit: { enabled: false } },
};

const REVIEWIT_PROJECT: Project = {
  id: "leanish/reviewit",
  source: { url: "https://github.com/leanish/reviewit.git", branch: "main" },
  extensions: { reviewit: { enabled: true } }, // no `bumpit` entry → default-on
};

describe("InMemoryCatalog", () => {
  const catalog = new InMemoryCatalog([ATC_PROJECT, REVIEWIT_PROJECT]);

  it("list() returns every project", () => {
    expect(catalog.list().map((p) => p.id)).toEqual([
      "leanish/atc",
      "leanish/reviewit",
    ]);
  });

  it("forConsumer applies default-on semantics", () => {
    expect(catalog.forConsumer("bumpit").list().map((p) => p.id)).toEqual([
      "leanish/reviewit",
    ]);
  });

  it("isEnabledForConsumer treats missing extensions as enabled", () => {
    expect(isEnabledForConsumer(REVIEWIT_PROJECT, "bumpit")).toBe(true);
    expect(isEnabledForConsumer(ATC_PROJECT, "bumpit")).toBe(false);
  });
});

describe("FilesystemCatalog (reads catalogit YAML layout)", () => {
  let catalogRoot: string;

  beforeAll(async () => {
    catalogRoot = await mkdtemp(join(tmpdir(), "catalogit-fs-"));
    await mkdir(join(catalogRoot, "projects"), { recursive: true });
    await writeFile(
      join(catalogRoot, "projects", "leanish_atc.yaml"),
      [
        "id: leanish/atc",
        "source:",
        "  url: https://github.com/leanish/atc.git",
        "  branch: main",
        "extensions:",
        "  atc:",
        "    enabled: true",
        "description: |",
        "  ATC repo",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    /* OS-managed tmpdir cleanup */
  });

  it("loads project YAML files into a catalog", async () => {
    const catalog = await FilesystemCatalog.load({ catalogRoot });
    expect(catalog.list().map((p) => p.id)).toEqual(["leanish/atc"]);
    expect(catalog.get("leanish/atc")?.description).toBe("ATC repo\n");
  });
});
