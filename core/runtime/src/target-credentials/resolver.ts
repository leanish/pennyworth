import type { CatalogReadOnly } from "@leanish/catalog-it";

import { TargetCredentialsError } from "../errors.js";
import type { SecretEntry } from "../logger/redactor.js";
import type { ClientMode } from "../needs/wire-clients.js";
import type { Logger } from "../types/logger.js";

import { CodeArtifactProvider } from "./providers/codeartifact.js";
import type { ResolvedEnvVar } from "./providers/resolved-env-var.js";
import { SsmProvider } from "./providers/ssm.js";
import type { CredentialEntry } from "./schema.js";
import { parseCredentialsExtension } from "./schema.js";

/**
 * Resolves the per-target-project credentials a skill invocation's working
 * copies declare (`extensions.credentials`) into the env map injected into
 * the coding-agent subprocess. Constructed once per process by the entry
 * shim (Lambda module / `run-local`) — mirroring how `SelfPublisher` is
 * shim-provided — and threaded through `BuildRuntimeOptions.targetCredentials`;
 * provider caches (CodeArtifact tokens) therefore live for the container's
 * lifetime.
 *
 * Uses the **unscoped** catalog (`CatalogReadOnly.get`) deliberately: the
 * credentials block is runtime-owned and cross-agent, not a per-consumer
 * extension namespace, and agents never see this surface (`runtime.catalog`
 * stays `forConsumer`-only).
 */
export interface ResolvedTargetCredentials {
  /** Env vars to merge into the coding-agent subprocess. */
  readonly env: Readonly<Record<string, string>>;
  /** Secret-flagged values, for redaction of captured output. */
  readonly secrets: ReadonlyArray<SecretEntry>;
}

export interface TargetCredentialsResolverOptions {
  readonly catalog: CatalogReadOnly;
  readonly mode: ClientMode;
  /** Region the suite's SSM parameters live in (the runtime's own region). */
  readonly region: string;
  readonly logger: Logger;
  /** Test hooks: replace the providers. */
  readonly codeartifactProvider?: CodeArtifactProvider;
  readonly ssmProvider?: SsmProvider;
}

export function createTargetCredentialsResolver(
  options: TargetCredentialsResolverOptions,
): TargetCredentialsResolver {
  return new TargetCredentialsResolver(options);
}

export class TargetCredentialsResolver {
  readonly #catalog: CatalogReadOnly;
  readonly #mode: ClientMode;
  readonly #logger: Logger;
  readonly #codeartifact: CodeArtifactProvider;
  readonly #ssm: SsmProvider;
  /** Working-copy ids with no catalog project, logged once per process. */
  readonly #loggedSkips = new Set<string>();

  constructor(options: TargetCredentialsResolverOptions) {
    this.#catalog = options.catalog;
    this.#mode = options.mode;
    this.#logger = options.logger;
    this.#codeartifact = options.codeartifactProvider ?? new CodeArtifactProvider();
    this.#ssm = options.ssmProvider ?? new SsmProvider({ region: options.region });
  }

  async resolveFor(projectIds: ReadonlyArray<string>): Promise<ResolvedTargetCredentials> {
    const env: Record<string, string> = {};
    const secrets: SecretEntry[] = [];
    const sources = new Map<string, { readonly value: string; readonly projectId: string }>();

    for (const projectId of new Set(projectIds)) {
      const project = this.#catalog.get(projectId);
      if (project === undefined) {
        // Synthetic working copies (e.g. triage-it's evidence mount) are
        // valid `WorkingCopy` values with no catalog record — they can't
        // declare credentials, so skip them. A typo'd real project id
        // would already have failed at `syncWorkingCopies`.
        if (!this.#loggedSkips.has(projectId)) {
          this.#loggedSkips.add(projectId);
          this.#logger.debug("target-credentials: working copy has no catalog project; skipping", {
            projectId,
          });
        }
        continue;
      }

      for (const entry of parseCredentialsExtension(project)) {
        for (const resolved of await this.#resolveEntry(projectId, entry)) {
          const prior = sources.get(resolved.name);
          if (prior !== undefined) {
            if (prior.value !== resolved.value) {
              throw new TargetCredentialsError(
                "env-conflict",
                `env '${resolved.name}' resolves to different values for projects ` +
                  `'${prior.projectId}' and '${projectId}' — multi-project runs need agreeing credentials`,
              );
            }
            continue; // identical value — dedupe
          }
          sources.set(resolved.name, { value: resolved.value, projectId });
          env[resolved.name] = resolved.value;
          if (resolved.secret) {
            secrets.push({ name: resolved.name, value: resolved.value });
          }
        }
      }
    }

    return { env, secrets };
  }

  async #resolveEntry(
    projectId: string,
    entry: CredentialEntry,
  ): Promise<ReadonlyArray<ResolvedEnvVar>> {
    try {
      return entry.provider === "codeartifact"
        ? await this.#codeartifact.resolve(entry)
        : await this.#ssm.resolve(entry);
    } catch (err) {
      if (err instanceof TargetCredentialsError) throw err;
      const hint =
        this.#mode === "local"
          ? " — local mode uses the ambient AWS credential chain; run `aws sso login` (or set AWS_PROFILE) and retry"
          : "";
      throw new TargetCredentialsError(
        "resolve-failed",
        `resolving env '${entry.env}' (provider '${entry.provider}') for project '${projectId}' failed: ` +
          `${err instanceof Error ? err.message : String(err)}${hint}`,
      );
    }
  }
}
