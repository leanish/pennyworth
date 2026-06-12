import { describe, expect, it } from "vitest";

import type { Project } from "@leanish/catalog-it";

import { TargetCredentialsError } from "../../src/errors.js";
import { parseCredentialsExtension } from "../../src/target-credentials/schema.js";

function project(credentials: unknown): Project {
  return {
    id: "acme/app",
    source: { url: "https://github.com/acme/app.git", branch: "main" },
    extensions: credentials === undefined ? {} : { credentials },
  };
}

function expectInvalid(credentials: unknown, messagePart: string): void {
  try {
    parseCredentialsExtension(project(credentials));
    expect.unreachable("expected TargetCredentialsError");
  } catch (err) {
    expect(err).toBeInstanceOf(TargetCredentialsError);
    expect((err as TargetCredentialsError).reason).toBe("invalid-config");
    expect((err as TargetCredentialsError).message).toContain(messagePart);
  }
}

const VALID_CODEARTIFACT = {
  provider: "codeartifact",
  domain: "acme",
  domainOwner: "123456789012",
  region: "us-east-1",
  env: "CODEARTIFACT_AUTH_TOKEN",
};

const VALID_SSM = {
  provider: "ssm",
  parameter: "/leanish/projects/acme/app/credentials/NPM_TOKEN",
  env: "NPM_TOKEN",
};

describe("parseCredentialsExtension", () => {
  it("returns [] when the block is absent", () => {
    expect(parseCredentialsExtension(project(undefined))).toEqual([]);
  });

  it("parses a codeartifact entry with endpoints", () => {
    const entries = parseCredentialsExtension(
      project([
        {
          ...VALID_CODEARTIFACT,
          endpoints: [{ repository: "java", format: "maven", env: "CODEARTIFACT_REPO_ENDPOINT" }],
        },
      ]),
    );
    expect(entries).toEqual([
      {
        ...VALID_CODEARTIFACT,
        endpoints: [{ repository: "java", format: "maven", env: "CODEARTIFACT_REPO_ENDPOINT" }],
      },
    ]);
  });

  it("parses an ssm entry under the project's convention path", () => {
    expect(parseCredentialsExtension(project([VALID_SSM]))).toEqual([VALID_SSM]);
  });

  it("rejects a non-array block", () => {
    expectInvalid({ provider: "ssm" }, "must be an array");
  });

  it("rejects an unknown provider", () => {
    expectInvalid([{ provider: "vault", env: "X" }], "unknown provider");
  });

  it("rejects unknown fields", () => {
    expectInvalid([{ ...VALID_SSM, extra: true }], "unknown field 'extra'");
  });

  it("rejects bad env names", () => {
    expectInvalid([{ ...VALID_SSM, env: "lower_case" }], "must match");
  });

  it("rejects the AWS_ prefix", () => {
    expectInvalid([{ ...VALID_SSM, env: "AWS_FOO" }], "reserved");
  });

  it("rejects reserved runner/system env names", () => {
    expectInvalid([{ ...VALID_SSM, env: "CODEX_HOME" }], "reserved runner/system env var");
  });

  it("rejects collisions with needs-registry env vars", () => {
    expectInvalid([{ ...VALID_SSM, env: "GITHUB_TOKEN" }], "collides with a needs-registry env var");
  });

  it("rejects ssm parameters outside the project's convention path", () => {
    expectInvalid(
      [{ ...VALID_SSM, parameter: "/leanish/projects/other/project/credentials/NPM_TOKEN" }],
      "must be '/leanish/projects/acme/app/credentials/<NAME>'",
    );
  });

  it("rejects ssm parameter names with extra path segments", () => {
    expectInvalid(
      [{ ...VALID_SSM, parameter: "/leanish/projects/acme/app/credentials/nested/NAME" }],
      "one non-empty segment",
    );
  });

  it("rejects duplicate env names across entries", () => {
    expectInvalid(
      [VALID_SSM, { ...VALID_CODEARTIFACT, env: "NPM_TOKEN" }],
      "already claimed",
    );
  });

  it("rejects missing required codeartifact fields", () => {
    expectInvalid(
      [{ provider: "codeartifact", env: "CODEARTIFACT_AUTH_TOKEN" }],
      ".domain: must be a non-empty string",
    );
  });

  it("rejects malformed endpoints", () => {
    expectInvalid(
      [{ ...VALID_CODEARTIFACT, endpoints: [{ repository: "java" }] }],
      ".format: must be a non-empty string",
    );
  });
});
