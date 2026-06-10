import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { writeProjectYaml, writeSkeleton, projectFileExists } from "../../src/project-writer.js";
import { FilesystemCatalog } from "../../src/filesystem-catalog.js";

describe("project-writer", () => {
  it("writes a full project record that round-trips through FilesystemCatalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "catit-"));
    await writeProjectYaml(root, {
      id: "leanish/foo",
      source: { url: "https://github.com/leanish/foo.git", branch: "main" },
      description: "hi",
      extensions: { atc: { enabled: true } },
    });
    const text = await readFile(join(root, "projects", "leanish_foo.yaml"), "utf8");
    expect(text).toContain("id: leanish/foo");
    expect(await projectFileExists(root, "leanish/foo")).toBe(true);

    const cat = await FilesystemCatalog.load({ catalogRoot: root });
    const got = cat.get("leanish/foo");
    expect(got?.description).toBe("hi");
    expect(got?.source.url).toBe("https://github.com/leanish/foo.git");
  });

  it("writeSkeleton omits branch/extensions/description", async () => {
    const root = await mkdtemp(join(tmpdir(), "catit-"));
    await writeSkeleton(root, "leanish/bar", "https://github.com/leanish/bar.git");
    const text = await readFile(join(root, "projects", "leanish_bar.yaml"), "utf8");
    expect(text).toContain("id: leanish/bar");
    expect(text).toContain("url: https://github.com/leanish/bar.git");
    expect(text).not.toContain("branch:");
    expect(text).not.toContain("extensions");
    expect(text).not.toContain("description");
  });

  it("projectFileExists is false when the file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "catit-"));
    expect(await projectFileExists(root, "leanish/missing")).toBe(false);
  });
});
