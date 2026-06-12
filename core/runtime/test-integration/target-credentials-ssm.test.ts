import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InMemoryCatalog, type Project } from "@leanish/catalog-it";

import { ConsoleLogger } from "../src/logger/console-logger.js";
import { createTargetCredentialsResolver } from "../src/target-credentials/resolver.js";
import { LocalStackHarness } from "../src/testing/localstack-harness.js";

/**
 * End-to-end test of the `ssm` credential provider against a real
 * Parameter Store: a `SecureString` under the project's convention path
 * is resolved through the production `SsmProvider` (no api hook — the
 * harness's `AWS_ENDPOINT_URL` steers the genuine SDK client) and lands
 * in the env map / secrets list the runtime injects into the
 * coding-agent subprocess.
 *
 * The CodeArtifact provider has no LocalStack-Community emulation, so it
 * is covered by SDK-mock contract tests only (see
 * `test/unit/target-credentials-resolver.test.ts`) — per the suite's
 * fail-loud rule, no fake-green pretend coverage here.
 *
 * `stack.start()` throws `LocalStackUnavailableError` if LocalStack isn't
 * reachable — the integration gate fails loudly rather than silently
 * skipping.
 */
describe("target-credentials ssm provider against LocalStack", () => {
  const stack = new LocalStackHarness();

  beforeAll(async () => {
    await stack.start();
  });

  afterAll(async () => {
    await stack.stop();
  });

  it("resolves a SecureString under the project convention path", async () => {
    const parameter = await stack.createSecureStringParameter(
      "/leanish/projects/acme/app/credentials/NPM_TOKEN",
      "shhh-npm-token",
    );

    const project: Project = {
      id: "acme/app",
      source: { url: "https://github.com/acme/app.git", branch: "main" },
      extensions: {
        credentials: [{ provider: "ssm", parameter, env: "NPM_TOKEN" }],
      },
    };

    const resolver = createTargetCredentialsResolver({
      catalog: new InMemoryCatalog([project]),
      mode: "aws",
      region: stack.region,
      logger: new ConsoleLogger({ minLevel: "error" }),
    });

    const resolved = await resolver.resolveFor(["acme/app"]);
    expect(resolved.env).toEqual({ NPM_TOKEN: "shhh-npm-token" });
    expect(resolved.secrets).toEqual([{ name: "NPM_TOKEN", value: "shhh-npm-token" }]);
  });

  it("fails loudly on a missing parameter", async () => {
    const project: Project = {
      id: "acme/ghost",
      source: { url: "https://github.com/acme/ghost.git", branch: "main" },
      extensions: {
        credentials: [
          {
            provider: "ssm",
            parameter: "/leanish/projects/acme/ghost/credentials/MISSING",
            env: "MISSING_TOKEN",
          },
        ],
      },
    };

    const resolver = createTargetCredentialsResolver({
      catalog: new InMemoryCatalog([project]),
      mode: "aws",
      region: stack.region,
      logger: new ConsoleLogger({ minLevel: "error" }),
    });

    await expect(resolver.resolveFor(["acme/ghost"])).rejects.toMatchObject({
      reason: "resolve-failed",
    });
  });
});
