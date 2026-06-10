import type { JiraClient } from "../types/clients.js";

import type { NeedSpec } from "./spec.js";

/**
 * `jira` need. Placeholder spec — mirrors the `github` need's shape: the
 * skill subprocess does the actual Jira work with the resolved
 * credentials; the typed client stays a marker until a handler needs
 * first-class calls (the real implementation lands then).
 */
export const jiraNeed: NeedSpec<JiraClient> = {
  name: "jira",
  envVars: [
    {
      name: "JIRA_BASE_URL",
      description: "Base URL of the Jira site, e.g. https://<org>.atlassian.net.",
    },
    {
      name: "JIRA_API_TOKEN",
      description:
        "API token for the agent's Jira service account. Resolved at cold " +
        "start from an SSM Parameter Store SecureString parameter.",
      secretBacked: true,
    },
  ],
  iamActions: [], // Jira auth doesn't go through IAM; the SSM SecureString fetch is granted by agent-infra.
  awsFactory() {
    return { kind: "jira" } satisfies JiraClient;
  },
  localFactory() {
    return { kind: "jira" } satisfies JiraClient;
  },
};
