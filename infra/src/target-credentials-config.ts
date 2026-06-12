/**
 * Deploy-time configuration for the `target-credentials` need's CodeArtifact
 * grants. Org-specific ARNs deliberately do NOT live in this (public) repo —
 * the operator supplies them via CDK context, either in the deploy
 * environment's `cdk.json` or on the command line:
 *
 *   cdk deploy --context targetCredentials='{
 *     "codeartifactDomainArns": ["arn:aws:codeartifact:us-east-1:123456789012:domain/acme"],
 *     "codeartifactRepositoryArns": ["arn:aws:codeartifact:us-east-1:123456789012:repository/acme/java"]
 *   }'
 *
 * Empty config (the default) means SSM-only grants: agents can resolve
 * stored per-project secrets, and every CodeArtifact entry in the catalog
 * fails at run time with an IAM denial until the domains are configured
 * here — loud, not silent.
 *
 * Cross-account domains additionally require the domain owner to allow the
 * suite account in the domain's resource policy; that side is owned by the
 * domain's account, not this stack.
 */
export interface TargetCredentialsInfraConfig {
  readonly codeartifactDomainArns: ReadonlyArray<string>;
  readonly codeartifactRepositoryArns: ReadonlyArray<string>;
}

export const TARGET_CREDENTIALS_CONTEXT_KEY = "targetCredentials";

export const NO_TARGET_CREDENTIALS_CONFIG: TargetCredentialsInfraConfig = {
  codeartifactDomainArns: [],
  codeartifactRepositoryArns: [],
};

/**
 * Parse the `targetCredentials` CDK context value. Accepts the object form
 * (from `cdk.json`) or a JSON string (from `--context k=v`). Absent →
 * empty config. Anything malformed throws — a typo'd deploy config must
 * not silently synth to SSM-only grants.
 */
export function parseTargetCredentialsContext(raw: unknown): TargetCredentialsInfraConfig {
  if (raw === undefined || raw === null) return NO_TARGET_CREDENTIALS_CONFIG;

  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(
        `agent-infra: context '${TARGET_CREDENTIALS_CONTEXT_KEY}' is not valid JSON: ${value}`,
      );
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `agent-infra: context '${TARGET_CREDENTIALS_CONTEXT_KEY}' must be an object with ` +
        `codeartifactDomainArns / codeartifactRepositoryArns arrays`,
    );
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "codeartifactDomainArns" && key !== "codeartifactRepositoryArns") {
      throw new Error(
        `agent-infra: context '${TARGET_CREDENTIALS_CONTEXT_KEY}' has unknown key '${key}'`,
      );
    }
  }

  return {
    codeartifactDomainArns: parseArnArray(record, "codeartifactDomainArns"),
    codeartifactRepositoryArns: parseArnArray(record, "codeartifactRepositoryArns"),
  };
}

function parseArnArray(record: Record<string, unknown>, key: string): ReadonlyArray<string> {
  const raw = record[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !v.startsWith("arn:"))) {
    throw new Error(
      `agent-infra: context '${TARGET_CREDENTIALS_CONTEXT_KEY}'.${key} must be an array of ARNs`,
    );
  }
  return raw as string[];
}
