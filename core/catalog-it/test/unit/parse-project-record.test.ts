import { describe, it, expect } from "vitest";

import { parseProjectRecord } from "../../src/parse-project-record.js";

const LOCATE = "test record";

function base(): Record<string, unknown> {
  return {
    id: "leanish/foo",
    source: { url: "https://github.com/leanish/foo.git" },
  };
}

describe("parseProjectRecord", () => {
  it("parses a minimal record, defaulting branch to main and extensions to {}", () => {
    const project = parseProjectRecord(base(), LOCATE);
    expect(project).toEqual({
      id: "leanish/foo",
      source: { url: "https://github.com/leanish/foo.git", branch: "main" },
      extensions: {},
    });
  });

  it("rejects a mixed-case id (canonical ids are lowercase owner/slug)", () => {
    // Regression: a mixed-case record (hand-edited, or left behind by older
    // tooling on a case-insensitive filesystem) used to parse fine and then
    // break the filename⇄id invariant once `add` lowercased over it.
    expect(() => parseProjectRecord({ ...base(), id: "Acme/Widget-Lib" }, LOCATE)).toThrowError(
      /requires 'id' in canonical lowercase owner\/slug form, got 'Acme\/Widget-Lib'/,
    );
  });

  it("rejects an id without an owner/slug separator", () => {
    expect(() => parseProjectRecord({ ...base(), id: "no-slash" }, LOCATE)).toThrowError(
      /requires 'id' in canonical lowercase owner\/slug form/,
    );
  });

  it("allows an empty-string description (spec: 'absent or a string')", () => {
    const project = parseProjectRecord({ ...base(), description: "" }, LOCATE);
    expect(project.description).toBe("");
  });

  it("rejects a non-string description", () => {
    expect(() => parseProjectRecord({ ...base(), description: 42 }, LOCATE)).toThrowError(
      /requires string 'description'/,
    );
  });

  it("rejects a present-but-non-string branch (strict — no silent coercion)", () => {
    expect(() =>
      parseProjectRecord({ id: "leanish/foo", source: { url: "x", branch: 5 } }, LOCATE),
    ).toThrowError(/source\.branch/);
  });

  it("rejects an extensions key that violates the [a-z][a-z0-9-]* namespace rule", () => {
    expect(() =>
      parseProjectRecord({ ...base(), extensions: { Bad_Key: {} } }, LOCATE),
    ).toThrowError(/extensions key 'Bad_Key'/);
  });

  it("rejects an extensions value that is not a JSON object", () => {
    expect(() =>
      parseProjectRecord({ ...base(), extensions: { atc: "nope" } }, LOCATE),
    ).toThrowError(/extensions\.atc must be a JSON object/);
  });

  it("accepts a well-formed extensions map", () => {
    const project = parseProjectRecord(
      { ...base(), extensions: { atc: { enabled: false } } },
      LOCATE,
    );
    expect(project.extensions).toEqual({ atc: { enabled: false } });
  });

  it("accepts the reserved credentials namespace as a list", () => {
    const credentials = [
      {
        provider: "ssm",
        parameter: "/leanish/projects/acme/app/credentials/NPM_TOKEN",
        env: "NPM_TOKEN",
      },
    ];
    const project = parseProjectRecord(
      { ...base(), extensions: { credentials, atc: { enabled: true } } },
      LOCATE,
    );
    expect(project.extensions["credentials"]).toEqual(credentials);
  });

  it("rejects a credentials namespace that is not a list", () => {
    expect(() =>
      parseProjectRecord({ ...base(), extensions: { credentials: { provider: "ssm" } } }, LOCATE),
    ).toThrowError(/extensions\.credentials must be a JSON array/);
  });
});
