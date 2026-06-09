import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { readPublishState, writePublishState } from "../../src/publish-state.js";

describe("publish-state", () => {
  let catalogRoot: string;

  beforeEach(async () => {
    catalogRoot = await mkdtemp(join(tmpdir(), "catit-state-"));
  });

  it("returns missing when the state file does not exist", async () => {
    await expect(readPublishState(catalogRoot)).resolves.toEqual({ kind: "missing" });
  });

  it("writes and reads the conflict-detection ETag", async () => {
    await writePublishState(catalogRoot, `"etag-1"`);

    await expect(readPublishState(catalogRoot)).resolves.toEqual({
      kind: "ok",
      etag: `"etag-1"`,
    });
    await expect(readFile(join(catalogRoot, ".catalogit-state.json"), "utf8")).resolves.toBe(
      JSON.stringify({ etag: `"etag-1"` }) + "\n",
    );
  });

  it("classifies invalid JSON as malformed", async () => {
    await writeFile(join(catalogRoot, ".catalogit-state.json"), "{", "utf8");

    await expect(readPublishState(catalogRoot)).resolves.toEqual({
      kind: "malformed",
      reason: "not valid JSON",
    });
  });

  it("classifies a missing string ETag as malformed", async () => {
    await writeFile(
      join(catalogRoot, ".catalogit-state.json"),
      JSON.stringify({ etag: 123 }),
      "utf8",
    );

    await expect(readPublishState(catalogRoot)).resolves.toEqual({
      kind: "malformed",
      reason: "missing string `etag` field",
    });
  });

  it("classifies present-but-unreadable state paths as malformed", async () => {
    await mkdir(join(catalogRoot, ".catalogit-state.json"));

    const state = await readPublishState(catalogRoot);
    expect(state.kind).toBe("malformed");
  });
});
