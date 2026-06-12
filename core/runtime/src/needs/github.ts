import type { GitHubClient } from "../types/clients.js";

import type { NeedSpec } from "./spec.js";

/**
 * `github` need. Placeholder spec — phase-1 ATC doesn't need it; phase-2
 * `agent-bumpit` does. The real `Octokit`-backed implementation lands
 * when bumpit's handler comes online.
 */
export const githubNeed: NeedSpec<GitHubClient> = {
  name: "github",
  envVars: [
    {
      name: "GITHUB_TOKEN",
      description:
        "Fine-grained GitHub PAT with the agent's required scopes. Resolved at " +
        "cold start from an SSM Parameter Store SecureString parameter.",
      secretBacked: true,
    },
  ],
  iamActions: [], // GitHub auth doesn't go through IAM; the SSM SecureString fetch (ssm:GetParameter + KMS decrypt) is granted by agent-infra.
  awsFactory() {
    return { kind: "github" } satisfies GitHubClient;
  },
  localFactory() {
    return { kind: "github" } satisfies GitHubClient;
  },
};
