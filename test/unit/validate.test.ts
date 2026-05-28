import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { catalogitCli, validateCatalog } from "../../src/index.js";

async function makeFixture(): Promise<{ root: string; projectsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "catalogit-validate-"));
  const projectsDir = join(root, "projects");
  await mkdir(projectsDir, { recursive: true });
  return { root, projectsDir };
}

describe("validateCatalog", () => {
  it("returns no issues for a clean catalog", async () => {
    const { root, projectsDir } = await makeFixture();
    await writeFile(
      join(projectsDir, "leanish_atc.yaml"),
      "id: leanish/atc\nsource:\n  url: https://github.com/leanish/atc.git\n  branch: main\n",
    );
    const result = await validateCatalog({ catalogRoot: root });
    expect(result.issues).toEqual([]);
    expect(result.projectsScanned).toBe(1);
  });

  it("reports a missing spine field with the file path + message", async () => {
    const { root, projectsDir } = await makeFixture();
    await writeFile(
      join(projectsDir, "leanish_broken.yaml"),
      "id: leanish/broken\nsource: {}\n",
    );
    const result = await validateCatalog({ catalogRoot: root });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.file).toContain("leanish_broken.yaml");
    expect(result.issues[0]!.message).toMatch(/source\.url/);
  });

  it("reports a malformed-YAML error", async () => {
    const { root, projectsDir } = await makeFixture();
    await writeFile(join(projectsDir, "bad.yaml"), "not: [valid yaml");
    const result = await validateCatalog({ catalogRoot: root });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toMatch(/parse/i);
  });

  it("reports a missing projects dir cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalogit-validate-empty-"));
    const result = await validateCatalog({ catalogRoot: root });
    expect(result.issues).toHaveLength(1);
    expect(result.projectsScanned).toBe(0);
    expect(result.issues[0]!.message).toMatch(/ENOENT|no such file/);
  });

  it("rejects unknown top-level spine fields (strict by default per ADR-0014)", async () => {
    const { root, projectsDir } = await makeFixture();
    await writeFile(
      join(projectsDir, "leanish_atc.yaml"),
      "id: leanish/atc\nsource:\n  url: https://github.com/leanish/atc.git\nownership: platform-team\n",
    );
    const result = await validateCatalog({ catalogRoot: root });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toMatch(/unknown spine field 'ownership'/);
  });

  it("rejects unknown source-nested fields (strict by default per ADR-0014)", async () => {
    const { root, projectsDir } = await makeFixture();
    await writeFile(
      join(projectsDir, "leanish_atc.yaml"),
      "id: leanish/atc\nsource:\n  url: https://github.com/leanish/atc.git\n  kind: github\n",
    );
    const result = await validateCatalog({ catalogRoot: root });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toMatch(/unknown spine field 'source\.kind'/);
  });

  it("does NOT reject unknown keys inside extensions (extensions is an open map by design)", async () => {
    const { root, projectsDir } = await makeFixture();
    await writeFile(
      join(projectsDir, "leanish_atc.yaml"),
      "id: leanish/atc\nsource:\n  url: https://github.com/leanish/atc.git\nextensions:\n  future-agent:\n    foo: bar\n",
    );
    const result = await validateCatalog({ catalogRoot: root });
    expect(result.issues).toEqual([]);
  });
});

describe("catalogit validate (CLI)", () => {
  function capture(stream: PassThrough): () => string {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    return () => buf;
  }

  it("exits 0 with a 'catalog OK' message when clean", async () => {
    const { root, projectsDir } = await makeFixture();
    await writeFile(
      join(projectsDir, "leanish_atc.yaml"),
      "id: leanish/atc\nsource:\n  url: https://github.com/leanish/atc.git\n  branch: main\n",
    );
    const stdout = new PassThrough();
    const read = capture(stdout);
    const code = await catalogitCli(["validate", "--catalog-root", root], {
      stdout,
      stderr: new PassThrough(),
    });
    expect(code).toBe(0);
    expect(read()).toContain("catalog OK");
    expect(read()).toContain("1 project");
  });

  it("exits 1 and lists issues on stderr when validation fails", async () => {
    const { root, projectsDir } = await makeFixture();
    await writeFile(join(projectsDir, "leanish_broken.yaml"), "id: leanish/broken\nsource: {}\n");
    const stderr = new PassThrough();
    const read = capture(stderr);
    const code = await catalogitCli(["validate", "--catalog-root", root], {
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).toBe(1);
    expect(read()).toContain("leanish_broken.yaml");
    expect(read()).toContain("catalog FAILED");
  });
});
