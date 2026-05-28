import { describe, it, expect } from "vitest";
import { mapRepoToId, idToFilename } from "../../src/repo-id.js";

describe("mapRepoToId", () => {
  it("lowercase-normalizes owner/repo into id + filename", () => {
    expect(mapRepoToId("Leanish", "Agent-ATC")).toEqual({
      ok: true, id: "leanish/agent-atc", owner: "leanish", slug: "agent-atc",
      filename: "leanish_agent-atc.yaml",
    });
  });
  it("preserves slug-legal punctuation (_ . -)", () => {
    const r = mapRepoToId("leanish", "my_repo.v2");
    expect(r.ok && r.id).toBe("leanish/my_repo.v2");
  });
  it("skips a name that can't satisfy the slug pattern", () => {
    expect(mapRepoToId("leanish", ".github")).toEqual({ ok: false, reason: expect.stringContaining("slug") });
  });
  it("skips an owner that can't satisfy the owner pattern", () => {
    expect(mapRepoToId("bad_owner", "ok")).toEqual({ ok: false, reason: expect.stringContaining("owner") });
  });
});

describe("idToFilename", () => {
  it("joins owner/slug into owner_slug.yaml", () => {
    expect(idToFilename("leanish/agent-atc")).toBe("leanish_agent-atc.yaml");
  });
});
