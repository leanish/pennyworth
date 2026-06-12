import { describe, expect, it } from "vitest";

import { InMemoryCatalog, type Project } from "@leanish/catalog-it";

import { TargetCredentialsError } from "../../src/errors.js";
import { ConsoleLogger } from "../../src/logger/console-logger.js";
import {
  CodeArtifactProvider,
  type CodeArtifactApi,
} from "../../src/target-credentials/providers/codeartifact.js";
import { SsmProvider, type SsmApi } from "../../src/target-credentials/providers/ssm.js";
import { createTargetCredentialsResolver } from "../../src/target-credentials/resolver.js";

const QUIET_LOGGER = new ConsoleLogger({ minLevel: "error" });

function projectWith(id: string, credentials: unknown): Project {
  return {
    id,
    source: { url: `https://github.com/${id}.git`, branch: "main" },
    extensions: { credentials },
  };
}

function ssmEntry(projectId: string, name: string, env: string) {
  return { provider: "ssm", parameter: `/leanish/projects/${projectId}/credentials/${name}`, env };
}

function fakeSsm(values: Record<string, string>): { api: SsmApi; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    api: {
      async getParameter(name) {
        calls.push(name);
        const value = values[name];
        if (value === undefined) throw new Error(`no such parameter ${name}`);
        return { value };
      },
    },
  };
}

function resolverWith(projects: Project[], ssmApi: SsmApi, mode: "aws" | "local" = "aws") {
  return createTargetCredentialsResolver({
    catalog: new InMemoryCatalog(projects),
    mode,
    region: "us-east-1",
    logger: QUIET_LOGGER,
    ssmProvider: new SsmProvider({ region: "us-east-1", api: ssmApi }),
  });
}

describe("TargetCredentialsResolver", () => {
  it("resolves declared entries into env + secrets", async () => {
    const { api } = fakeSsm({ "/leanish/projects/acme/app/credentials/NPM_TOKEN": "tok-123" });
    const resolver = resolverWith(
      [projectWith("acme/app", [ssmEntry("acme/app", "NPM_TOKEN", "NPM_TOKEN")])],
      api,
    );
    const resolved = await resolver.resolveFor(["acme/app"]);
    expect(resolved.env).toEqual({ NPM_TOKEN: "tok-123" });
    expect(resolved.secrets).toEqual([{ name: "NPM_TOKEN", value: "tok-123" }]);
  });

  it("skips working copies with no catalog project (synthetic mounts)", async () => {
    const { api, calls } = fakeSsm({});
    const resolver = resolverWith([], api);
    const resolved = await resolver.resolveFor(["triage-it:evidence"]);
    expect(resolved.env).toEqual({});
    expect(calls).toEqual([]);
  });

  it("returns empty for projects without a credentials block", async () => {
    const { api } = fakeSsm({});
    const project: Project = {
      id: "acme/plain",
      source: { url: "https://github.com/acme/plain.git", branch: "main" },
      extensions: {},
    };
    const resolver = resolverWith([project], api);
    expect((await resolver.resolveFor(["acme/plain"])).env).toEqual({});
  });

  it("dedupes identical values and rejects conflicting ones across projects", async () => {
    const { api } = fakeSsm({
      "/leanish/projects/acme/one/credentials/SHARED": "tok-aaa",
      "/leanish/projects/acme/two/credentials/SHARED": "tok-aaa",
      "/leanish/projects/acme/three/credentials/SHARED": "tok-bbb",
    });
    const projects = [
      projectWith("acme/one", [ssmEntry("acme/one", "SHARED", "SHARED_TOKEN")]),
      projectWith("acme/two", [ssmEntry("acme/two", "SHARED", "SHARED_TOKEN")]),
      projectWith("acme/three", [ssmEntry("acme/three", "SHARED", "SHARED_TOKEN")]),
    ];
    const resolver = resolverWith(projects, api);

    const agreeing = await resolver.resolveFor(["acme/one", "acme/two"]);
    expect(agreeing.env).toEqual({ SHARED_TOKEN: "tok-aaa" });

    try {
      await resolver.resolveFor(["acme/one", "acme/three"]);
      expect.unreachable("expected TargetCredentialsError");
    } catch (err) {
      expect(err).toBeInstanceOf(TargetCredentialsError);
      expect((err as TargetCredentialsError).reason).toBe("env-conflict");
      // Names projects and the env var — never the values.
      expect((err as TargetCredentialsError).message).toContain("SHARED_TOKEN");
      expect((err as TargetCredentialsError).message).toContain("acme/one");
      expect((err as TargetCredentialsError).message).toContain("acme/three");
      expect((err as TargetCredentialsError).message).not.toContain("tok-aaa");
      expect((err as TargetCredentialsError).message).not.toContain("tok-bbb");
    }
  });

  it("wraps provider failures with the aws-sso hint in local mode only", async () => {
    const failing: SsmApi = {
      async getParameter() {
        throw new Error("Could not load credentials from any providers");
      },
    };
    const projects = [projectWith("acme/app", [ssmEntry("acme/app", "NPM_TOKEN", "NPM_TOKEN")])];

    await expect(
      resolverWith(projects, failing, "local").resolveFor(["acme/app"]),
    ).rejects.toThrow(/aws sso login/);

    try {
      await resolverWith(projects, failing, "aws").resolveFor(["acme/app"]);
      expect.unreachable("expected TargetCredentialsError");
    } catch (err) {
      expect(err).toBeInstanceOf(TargetCredentialsError);
      expect((err as TargetCredentialsError).reason).toBe("resolve-failed");
      expect((err as TargetCredentialsError).message).not.toContain("aws sso login");
    }
  });

  it("surfaces invalid credentials blocks as invalid-config", async () => {
    const { api } = fakeSsm({});
    const resolver = resolverWith([projectWith("acme/app", "not-an-array")], api);
    await expect(resolver.resolveFor(["acme/app"])).rejects.toMatchObject({
      reason: "invalid-config",
    });
  });
});

describe("CodeArtifactProvider warm-token cache", () => {
  const ENTRY = {
    provider: "codeartifact" as const,
    domain: "acme",
    domainOwner: "123456789012",
    region: "us-east-1",
    env: "CODEARTIFACT_AUTH_TOKEN",
    endpoints: [{ repository: "java", format: "maven", env: "CODEARTIFACT_REPO_ENDPOINT" }],
  };

  function fakeApi(): { api: CodeArtifactApi; tokenCalls: () => number; endpointCalls: () => number } {
    let tokens = 0;
    let endpoints = 0;
    return {
      tokenCalls: () => tokens,
      endpointCalls: () => endpoints,
      api: {
        async getAuthorizationToken() {
          tokens += 1;
          return {
            authorizationToken: `token-${tokens}`,
            // 12h TTL from a fixed epoch.
            expiration: new Date(12 * 60 * 60 * 1000),
          };
        },
        async getRepositoryEndpoint() {
          endpoints += 1;
          return { repositoryEndpoint: "https://acme-123456789012.d.codeartifact.us-east-1.amazonaws.com/maven/java/" };
        },
      },
    };
  }

  it("mints once, reuses while expiration is ahead, re-mints after", async () => {
    let nowMs = 0;
    const { api, tokenCalls } = fakeApi();
    const provider = new CodeArtifactProvider({
      apiFactory: () => api,
      now: () => new Date(nowMs),
    });

    const first = await provider.resolve(ENTRY);
    expect(first).toContainEqual({ name: "CODEARTIFACT_AUTH_TOKEN", value: "token-1", secret: true });
    expect(tokenCalls()).toBe(1);

    // 11 h later: still inside expiration - 10 min margin → reused.
    nowMs = 11 * 60 * 60 * 1000;
    expect(await provider.resolve(ENTRY)).toContainEqual({
      name: "CODEARTIFACT_AUTH_TOKEN",
      value: "token-1",
      secret: true,
    });
    expect(tokenCalls()).toBe(1);

    // Inside the 10-minute safety margin → re-minted.
    nowMs = 12 * 60 * 60 * 1000 - 5 * 60 * 1000;
    expect(await provider.resolve(ENTRY)).toContainEqual({
      name: "CODEARTIFACT_AUTH_TOKEN",
      value: "token-2",
      secret: true,
    });
    expect(tokenCalls()).toBe(2);
  });

  it("marks endpoint URLs non-secret and caches them forever", async () => {
    const { api, endpointCalls } = fakeApi();
    const provider = new CodeArtifactProvider({ apiFactory: () => api, now: () => new Date(0) });

    const resolved = await provider.resolve(ENTRY);
    expect(resolved).toContainEqual({
      name: "CODEARTIFACT_REPO_ENDPOINT",
      value: "https://acme-123456789012.d.codeartifact.us-east-1.amazonaws.com/maven/java/",
      secret: false,
    });
    await provider.resolve(ENTRY);
    expect(endpointCalls()).toBe(1);
  });
});
