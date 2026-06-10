import { describe, expect, it } from "vitest";

import { bundleCatalog, type Project } from "../../src/index.js";

const ATC: Project = {
  id: "leanish/agent-atc",
  source: { url: "https://github.com/leanish/agent-atc.git", branch: "main" },
  extensions: { atc: { enabled: true } },
  description: "ATC repo",
};

const REVIEWIT: Project = {
  id: "leanish/reviewit",
  source: { url: "https://github.com/leanish/reviewit.git", branch: "main" },
  extensions: {},
};

const SECUREIT: Project = {
  id: "leanish/agent-secureit",
  source: { url: "https://github.com/leanish/agent-secureit.git", branch: "main" },
  extensions: { secureit: { enabled: true }, atc: { enabled: false } },
};

describe("bundleCatalog", () => {
  it("emits version: '1' and projects sorted by id ascending", () => {
    const body = bundleCatalog([REVIEWIT, ATC, SECUREIT]);
    const parsed = JSON.parse(body);
    expect(parsed.version).toBe("1");
    expect(parsed.projects.map((p: { id: string }) => p.id)).toEqual([
      "leanish/agent-atc",
      "leanish/agent-secureit",
      "leanish/reviewit",
    ]);
  });

  it("emits per-project keys in the documented order (id, source, extensions, description)", () => {
    const body = bundleCatalog([ATC]);
    // The JSON string preserves key insertion order — verify by literal substring.
    const expected = JSON.stringify({
      version: "1",
      projects: [
        {
          id: "leanish/agent-atc",
          source: { url: ATC.source.url, branch: "main" },
          extensions: { atc: { enabled: true } },
          description: "ATC repo",
        },
      ],
    });
    expect(body).toBe(expected);
  });

  it("omits empty extensions and absent description", () => {
    const body = bundleCatalog([REVIEWIT]);
    const parsed = JSON.parse(body);
    expect(parsed.projects[0]).toEqual({
      id: REVIEWIT.id,
      source: { url: REVIEWIT.source.url, branch: "main" },
    });
    expect(parsed.projects[0]).not.toHaveProperty("extensions");
    expect(parsed.projects[0]).not.toHaveProperty("description");
  });

  it("sorts extension keys ascending for stability", () => {
    const body = bundleCatalog([SECUREIT]);
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed.projects[0].extensions)).toEqual(["atc", "secureit"]);
  });

  it("recursively sorts nested object keys inside each extension namespace", () => {
    const project: Project = {
      id: "leanish/specit",
      source: {
        url: "https://github.com/leanish/specit.git",
        branch: "main",
      },
      // Top-level extension keys are reverse-alpha, AND each one has
      // nested keys in non-alphabetical order. Both layers should be
      // sorted in the emitted bundle.
      extensions: {
        z: { beta: 2, alpha: 1, gamma: { delta: 4, charlie: 3 } },
        a: { yankee: "y", xray: "x" },
      },
    };
    const body = bundleCatalog([project]);
    const parsed = JSON.parse(body);
    // Top level.
    expect(Object.keys(parsed.projects[0].extensions)).toEqual(["a", "z"]);
    // One level down.
    expect(Object.keys(parsed.projects[0].extensions.a)).toEqual(["xray", "yankee"]);
    expect(Object.keys(parsed.projects[0].extensions.z)).toEqual(["alpha", "beta", "gamma"]);
    // Two levels down.
    expect(Object.keys(parsed.projects[0].extensions.z.gamma)).toEqual(["charlie", "delta"]);
  });

  it("preserves array order (arrays are sequence-typed, not bag-typed)", () => {
    const project: Project = {
      id: "leanish/specit",
      source: { url: "https://x.git", branch: "main" },
      extensions: { specit: { allowed: ["c", "a", "b"] } },
    };
    const body = bundleCatalog([project]);
    const parsed = JSON.parse(body);
    expect(parsed.projects[0].extensions.specit.allowed).toEqual(["c", "a", "b"]);
  });

  it("byte-identical input → byte-identical output (stable)", () => {
    const a = bundleCatalog([ATC, REVIEWIT, SECUREIT]);
    const b = bundleCatalog([SECUREIT, ATC, REVIEWIT]); // different input order
    expect(a).toBe(b);
  });
});
