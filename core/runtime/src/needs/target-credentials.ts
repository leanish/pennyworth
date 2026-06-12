import type { TargetCredentialsClient } from "../types/clients.js";

import type { NeedSpec } from "./spec.js";

/**
 * `target-credentials` need. Declaring it opts an agent into per-target-
 * project credential resolution: at each `runSkill`, the runtime resolves
 * the working copies' `extensions.credentials` blocks (CodeArtifact tokens,
 * SSM-stored secrets) and injects them into the coding-agent subprocess
 * env. Agents without the need never resolve or inject anything.
 *
 * No env vars of its own — every env var this need materializes is named
 * by catalog data. The machinery lives in `TargetCredentialsResolver`
 * (wired by the entry shim via `BuildRuntimeOptions.targetCredentials`);
 * the client here is a placeholder marker like `github`'s.
 *
 * `iamActions` are read by agent-infra, which splits them into scoped
 * statements (SSM convention-path wildcard always; CodeArtifact statements
 * only for deploy-configured domains/repos) — see agent-infra's
 * `needs-policy.ts`.
 */
export const targetCredentialsNeed: NeedSpec<TargetCredentialsClient> = {
  name: "target-credentials",
  envVars: [],
  iamActions: [
    "codeartifact:GetAuthorizationToken",
    "codeartifact:GetRepositoryEndpoint",
    "codeartifact:ReadFromRepository",
    "ssm:GetParameter",
    "sts:GetServiceBearerToken",
  ],
  awsFactory() {
    return { kind: "target-credentials" } satisfies TargetCredentialsClient;
  },
  localFactory() {
    return { kind: "target-credentials" } satisfies TargetCredentialsClient;
  },
};
