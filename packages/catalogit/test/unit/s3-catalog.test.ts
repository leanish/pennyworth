import { describe, expect, it } from "vitest";

import { parseBundle } from "../../src/index.js";

describe("S3Catalog.parseBundle", () => {
  it("parses a valid catalog.json bundle", () => {
    const bundle = parseBundle(
      JSON.stringify({
        version: "1",
        projects: [
          {
            id: "leanish/agent-atc",
            source: { url: "https://github.com/leanish/agent-atc.git", branch: "main" },
            extensions: { atc: { enabled: true } },
            description: "ATC repo",
          },
          {
            id: "leanish/agent-secureit",
            source: { url: "https://github.com/leanish/agent-secureit.git" }, // branch default
            extensions: {},
          },
        ],
      }),
      "s3://test/catalog.json",
    );
    expect(bundle.version).toBe("1");
    expect(bundle.projects).toHaveLength(2);
    expect(bundle.projects[0]?.source.branch).toBe("main");
    expect(bundle.projects[1]?.source.branch).toBe("main"); // default applied
  });

  it("rejects unsupported bundle versions", () => {
    expect(() =>
      parseBundle(JSON.stringify({ version: "2", projects: [] }), "s3://test/catalog.json"),
    ).toThrowError(/unsupported catalog version '2'/);
  });

  it("rejects projects missing required fields", () => {
    expect(() =>
      parseBundle(
        JSON.stringify({
          version: "1",
          projects: [{ id: "ok/one", source: {} }],
        }),
        "src",
      ),
    ).toThrowError(/non-empty string 'source\.url'/);
  });

  it("rejects unknown source-nested keys (strict by default per ADR-0014)", () => {
    // ADR-0014 (strict-by-default amendment): the loader rejects unknown
    // spine fields rather than silently dropping them. Forward-compat for
    // additive changes goes via a bundle `version` bump, not via tolerance.
    // `source.kind` is the canonical example — it's not part of the phase-1
    // `ProjectSource` type, so a bundle carrying it fails loud at edit time.
    // Reintroducing it later is a schema-major bump (catalog `version: "2"`),
    // not an additive change.
    expect(() =>
      parseBundle(
        JSON.stringify({
          version: "1",
          projects: [
            {
              id: "leanish/atc",
              source: { kind: "github", url: "https://github.com/leanish/atc.git" },
              extensions: {},
            },
          ],
        }),
        "src",
      ),
    ).toThrowError(/unknown spine field 'source\.kind'/);
  });

  it("rejects unknown project top-level keys (strict by default per ADR-0014)", () => {
    expect(() =>
      parseBundle(
        JSON.stringify({
          version: "1",
          projects: [
            {
              id: "leanish/atc",
              source: { url: "https://github.com/leanish/atc.git" },
              extensions: {},
              ownership: "platform-team", // not part of the phase-1 spine
            },
          ],
        }),
        "src",
      ),
    ).toThrowError(/unknown spine field 'ownership'/);
  });

  it("rejects unknown bundle top-level keys (strict by default per ADR-0014)", () => {
    expect(() =>
      parseBundle(
        JSON.stringify({
          version: "1",
          projects: [],
          publishedAt: "2026-01-01T00:00:00Z", // not part of the phase-1 bundle shape
        }),
        "src",
      ),
    ).toThrowError(/unknown bundle field 'publishedAt'/);
  });

  it("does NOT reject unknown keys inside `extensions` (extensions is an open map by design)", () => {
    // The strict-spine discipline applies to the spine only. Per ADR-0008,
    // `extensions` is deliberately an open map keyed by agent identifier;
    // each agent owns its own slice. Adding a new agent's namespace must
    // not require a schema bump.
    const bundle = parseBundle(
      JSON.stringify({
        version: "1",
        projects: [
          {
            id: "leanish/atc",
            source: { url: "https://github.com/leanish/atc.git" },
            extensions: { atc: { enabled: true }, "future-agent": { foo: "bar" } },
          },
        ],
      }),
      "src",
    );
    expect(bundle.projects[0]?.extensions).toHaveProperty("future-agent");
  });
});
