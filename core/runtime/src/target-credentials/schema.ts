import type { Project } from "@leanish/catalog-it";

import { TargetCredentialsError } from "../errors.js";
import { needSpecs } from "../needs/registry.js";

/**
 * Schema + validation for the catalog's `extensions.credentials` block —
 * the runtime-owned, cross-agent namespace that carries per-target-project
 * credentials (per the target-credentials design; see the runtime README
 * §Target-project credentials).
 *
 * Unlike the per-agent `extensions.<agent-id>` namespaces, this block is
 * read by the runtime itself (the `TargetCredentialsResolver`), not by
 * agent handler code. catalog-it deliberately keeps `extensions` opaque;
 * the provider-specific validation lives here, with the owner of the
 * concept, and runs fail-loud before any agent work touches the project.
 */

export const CREDENTIALS_EXTENSION_KEY = "credentials";

export interface CodeArtifactEndpoint {
  readonly repository: string;
  readonly format: string;
  readonly env: string;
}

/**
 * Derived credential: minted at run time from the execution role's IAM via
 * `codeartifact:GetAuthorizationToken` — no stored secret exists. Org
 * specifics (domain, owner account, region) are pure catalog data so the
 * suite stays org-agnostic.
 */
export interface CodeArtifactCredentialEntry {
  readonly provider: "codeartifact";
  readonly domain: string;
  readonly domainOwner: string;
  readonly region: string;
  readonly env: string;
  /** Optional repository-endpoint URLs (non-secret), one env var each. */
  readonly endpoints: ReadonlyArray<CodeArtifactEndpoint>;
}

/**
 * Stored credential: an SSM Parameter Store `SecureString` under the
 * project's convention path. The universal fallback for any registry /
 * repo / API whose auth is a static token (ADR-0010: SSM is the suite's
 * only secret store).
 */
export interface SsmCredentialEntry {
  readonly provider: "ssm";
  readonly parameter: string;
  readonly env: string;
}

export type CredentialEntry = CodeArtifactCredentialEntry | SsmCredentialEntry;

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Env names a credentials entry may never claim, beyond the needs-registry
 * env vars (which are collected dynamically): runner/system vars whose
 * override would change the subprocess's behavior in ways that have nothing
 * to do with target credentials. The `AWS_` prefix is banned wholesale —
 * the runners scrub the Lambda role's AWS credential vars from the
 * subprocess env (see `spawn-capture.ts`), and catalog data must not be
 * able to smuggle them back in.
 */
export const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "NODE_OPTIONS",
  "CODEX_HOME",
]);

const BANNED_ENV_PREFIX = "AWS_";

/**
 * Parse + validate a project's `extensions.credentials` block. Returns `[]`
 * when the block is absent (the common case — credentials are opt-in per
 * project). Throws `TargetCredentialsError("invalid-config")` listing every
 * issue found — fail loud, never a partial parse.
 */
export function parseCredentialsExtension(project: Project): ReadonlyArray<CredentialEntry> {
  const raw = project.extensions[CREDENTIALS_EXTENSION_KEY];
  if (raw === undefined) return [];

  const issues: string[] = [];
  if (!Array.isArray(raw)) {
    fail(project.id, [`extensions.credentials must be an array, got ${typeOf(raw)}`]);
  }

  const entries: CredentialEntry[] = [];
  const claimedEnvNames = new Map<string, number>();
  (raw as unknown[]).forEach((item, index) => {
    const entry = parseEntry(project.id, item, index, issues);
    if (entry === undefined) return;
    entries.push(entry);
    for (const name of envNamesOf(entry)) {
      const priorIndex = claimedEnvNames.get(name);
      if (priorIndex !== undefined) {
        issues.push(
          `credentials[${index}]: env '${name}' is already claimed by credentials[${priorIndex}]`,
        );
      } else {
        claimedEnvNames.set(name, index);
      }
    }
  });

  if (issues.length > 0) fail(project.id, issues);
  return entries;
}

function envNamesOf(entry: CredentialEntry): ReadonlyArray<string> {
  return entry.provider === "codeartifact"
    ? [entry.env, ...entry.endpoints.map((e) => e.env)]
    : [entry.env];
}

function parseEntry(
  projectId: string,
  item: unknown,
  index: number,
  issues: string[],
): CredentialEntry | undefined {
  if (!isRecord(item)) {
    issues.push(`credentials[${index}]: must be an object, got ${typeOf(item)}`);
    return undefined;
  }
  const provider = item["provider"];
  switch (provider) {
    case "codeartifact":
      return parseCodeArtifactEntry(item, index, issues);
    case "ssm":
      return parseSsmEntry(projectId, item, index, issues);
    default:
      issues.push(
        `credentials[${index}]: unknown provider ${JSON.stringify(provider)} (known: codeartifact, ssm)`,
      );
      return undefined;
  }
}

function parseCodeArtifactEntry(
  item: Record<string, unknown>,
  index: number,
  issues: string[],
): CodeArtifactCredentialEntry | undefined {
  const before = issues.length;
  checkUnknownFields(item, index, issues, [
    "provider",
    "domain",
    "domainOwner",
    "region",
    "env",
    "endpoints",
  ]);
  const domain = requireString(item, "domain", index, issues);
  const domainOwner = requireString(item, "domainOwner", index, issues);
  const region = requireString(item, "region", index, issues);
  const env = requireEnvName(item, "env", index, issues);

  const endpoints: CodeArtifactEndpoint[] = [];
  const rawEndpoints = item["endpoints"];
  if (rawEndpoints !== undefined) {
    if (!Array.isArray(rawEndpoints)) {
      issues.push(`credentials[${index}].endpoints: must be an array, got ${typeOf(rawEndpoints)}`);
    } else {
      rawEndpoints.forEach((rawEndpoint, endpointIndex) => {
        const label = `credentials[${index}].endpoints[${endpointIndex}]`;
        if (!isRecord(rawEndpoint)) {
          issues.push(`${label}: must be an object, got ${typeOf(rawEndpoint)}`);
          return;
        }
        checkUnknownFields(rawEndpoint, index, issues, ["repository", "format", "env"], label);
        const repository = requireString(rawEndpoint, "repository", index, issues, label);
        const format = requireString(rawEndpoint, "format", index, issues, label);
        const endpointEnv = requireEnvName(rawEndpoint, "env", index, issues, label);
        if (repository !== undefined && format !== undefined && endpointEnv !== undefined) {
          endpoints.push({ repository, format, env: endpointEnv });
        }
      });
    }
  }

  if (issues.length > before) return undefined;
  return {
    provider: "codeartifact",
    domain: domain!,
    domainOwner: domainOwner!,
    region: region!,
    env: env!,
    endpoints,
  };
}

function parseSsmEntry(
  projectId: string,
  item: Record<string, unknown>,
  index: number,
  issues: string[],
): SsmCredentialEntry | undefined {
  const before = issues.length;
  checkUnknownFields(item, index, issues, ["provider", "parameter", "env"]);
  const parameter = requireString(item, "parameter", index, issues);
  const env = requireEnvName(item, "env", index, issues);

  if (parameter !== undefined) {
    // Convention path, project id verbatim (injective — no slugging): the
    // exact prefix pins the parameter to THIS project, so one static IAM
    // wildcard (`parameter/leanish/projects/*/credentials/*`) stays safe
    // and a project can never reference another project's secrets.
    const requiredPrefix = `/leanish/projects/${projectId}/credentials/`;
    const name = parameter.startsWith(requiredPrefix)
      ? parameter.slice(requiredPrefix.length)
      : undefined;
    if (name === undefined || name.length === 0 || name.includes("/")) {
      issues.push(
        `credentials[${index}].parameter: must be '${requiredPrefix}<NAME>' (one non-empty segment), got '${parameter}'`,
      );
    }
  }

  if (issues.length > before) return undefined;
  return { provider: "ssm", parameter: parameter!, env: env! };
}

function requireEnvName(
  item: Record<string, unknown>,
  field: string,
  index: number,
  issues: string[],
  label = `credentials[${index}]`,
): string | undefined {
  const value = requireString(item, field, index, issues, label);
  if (value === undefined) return undefined;
  if (!ENV_NAME_PATTERN.test(value)) {
    issues.push(`${label}.${field}: '${value}' must match ${String(ENV_NAME_PATTERN)}`);
    return undefined;
  }
  if (value.startsWith(BANNED_ENV_PREFIX)) {
    issues.push(
      `${label}.${field}: '${value}' — the '${BANNED_ENV_PREFIX}' prefix is reserved (the runtime scrubs AWS credential vars from the subprocess; catalog data can't re-add them)`,
    );
    return undefined;
  }
  if (RESERVED_ENV_NAMES.has(value)) {
    issues.push(`${label}.${field}: '${value}' is a reserved runner/system env var`);
    return undefined;
  }
  if (needEnvVarNames().has(value)) {
    issues.push(
      `${label}.${field}: '${value}' collides with a needs-registry env var (suite-level credential)`,
    );
    return undefined;
  }
  return value;
}

/** All env var names any registered need declares (e.g. GITHUB_TOKEN). */
function needEnvVarNames(): Set<string> {
  const names = new Set<string>();
  for (const spec of needSpecs.values()) {
    for (const envVar of spec.envVars) names.add(envVar.name);
  }
  return names;
}

function requireString(
  item: Record<string, unknown>,
  field: string,
  index: number,
  issues: string[],
  label = `credentials[${index}]`,
): string | undefined {
  const value = item[field];
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${label}.${field}: must be a non-empty string, got ${typeOf(value)}`);
    return undefined;
  }
  return value;
}

function checkUnknownFields(
  item: Record<string, unknown>,
  index: number,
  issues: string[],
  known: ReadonlyArray<string>,
  label = `credentials[${index}]`,
): void {
  for (const key of Object.keys(item)) {
    if (!known.includes(key)) {
      issues.push(`${label}: unknown field '${key}' (known: ${known.join(", ")})`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fail(projectId: string, issues: ReadonlyArray<string>): never {
  throw new TargetCredentialsError(
    "invalid-config",
    `project '${projectId}' has an invalid extensions.credentials block:\n  - ${issues.join("\n  - ")}`,
  );
}
