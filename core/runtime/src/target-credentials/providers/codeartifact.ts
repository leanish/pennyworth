import {
  CodeartifactClient,
  GetAuthorizationTokenCommand,
  GetRepositoryEndpointCommand,
  type PackageFormat,
} from "@aws-sdk/client-codeartifact";

import { awsClientDefaults } from "../../aws-mode/client-config.js";
import { TargetCredentialsError } from "../../errors.js";
import type { CodeArtifactCredentialEntry } from "../schema.js";
import type { ResolvedEnvVar } from "./resolved-env-var.js";

/**
 * Derived-credential provider for AWS CodeArtifact. Mints the authorization
 * token from the caller's IAM identity (`codeartifact:GetAuthorizationToken`
 * + `sts:GetServiceBearerToken`) — no stored secret anywhere. The minted
 * token's powers are read-only by construction: the role carries no
 * CodeArtifact publish actions (see agent-infra's needs policy).
 *
 * Warm-container reuse: tokens are requested with the service-default TTL
 * (12 h) and cached per `(domain, domainOwner, region)` with the response's
 * own `expiration` as the validity check — a reused Lambda container whose
 * cached token is still ahead of `expiration - safety margin` skips the
 * mint entirely. Repository endpoints never expire and cache forever.
 *
 * The SDK surface is injected behind `CodeArtifactApi` so unit tests drive
 * cache/expiry behavior with a fake clock and no AWS calls.
 */
export interface CodeArtifactApi {
  getAuthorizationToken(args: {
    readonly domain: string;
    readonly domainOwner: string;
  }): Promise<{ readonly authorizationToken: string; readonly expiration: Date }>;
  getRepositoryEndpoint(args: {
    readonly domain: string;
    readonly domainOwner: string;
    readonly repository: string;
    readonly format: string;
  }): Promise<{ readonly repositoryEndpoint: string }>;
}

export interface CodeArtifactProviderOptions {
  /** Test hook: replace the per-region SDK client construction. */
  readonly apiFactory?: (region: string) => CodeArtifactApi;
  /** Test hook: injected clock for cache-expiry logic. */
  readonly now?: () => Date;
  /** Reuse margin before `expiration`; defaults to 10 minutes. */
  readonly safetyMarginMs?: number;
}

const DEFAULT_SAFETY_MARGIN_MS = 10 * 60 * 1000;

interface CachedToken {
  readonly value: string;
  readonly expirationMs: number;
}

export class CodeArtifactProvider {
  readonly #apiFactory: (region: string) => CodeArtifactApi;
  readonly #now: () => Date;
  readonly #safetyMarginMs: number;
  readonly #apis = new Map<string, CodeArtifactApi>();
  readonly #tokens = new Map<string, CachedToken>();
  readonly #endpoints = new Map<string, string>();

  constructor(options: CodeArtifactProviderOptions = {}) {
    this.#apiFactory = options.apiFactory ?? createSdkApi;
    this.#now = options.now ?? (() => new Date());
    this.#safetyMarginMs = options.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  }

  async resolve(entry: CodeArtifactCredentialEntry): Promise<ReadonlyArray<ResolvedEnvVar>> {
    const api = this.#apiFor(entry.region);
    const resolved: ResolvedEnvVar[] = [
      { name: entry.env, value: await this.#token(api, entry), secret: true },
    ];
    for (const endpoint of entry.endpoints) {
      resolved.push({
        name: endpoint.env,
        value: await this.#endpoint(api, entry, endpoint.repository, endpoint.format),
        secret: false,
      });
    }
    return resolved;
  }

  async #token(api: CodeArtifactApi, entry: CodeArtifactCredentialEntry): Promise<string> {
    const key = `${entry.domain}|${entry.domainOwner}|${entry.region}`;
    const cached = this.#tokens.get(key);
    const nowMs = this.#now().getTime();
    if (cached !== undefined && cached.expirationMs - this.#safetyMarginMs > nowMs) {
      return cached.value;
    }
    const response = await api.getAuthorizationToken({
      domain: entry.domain,
      domainOwner: entry.domainOwner,
    });
    this.#tokens.set(key, {
      value: response.authorizationToken,
      expirationMs: response.expiration.getTime(),
    });
    return response.authorizationToken;
  }

  async #endpoint(
    api: CodeArtifactApi,
    entry: CodeArtifactCredentialEntry,
    repository: string,
    format: string,
  ): Promise<string> {
    const key = `${entry.domain}|${entry.domainOwner}|${entry.region}|${repository}|${format}`;
    const cached = this.#endpoints.get(key);
    if (cached !== undefined) return cached;
    const response = await api.getRepositoryEndpoint({
      domain: entry.domain,
      domainOwner: entry.domainOwner,
      repository,
      format,
    });
    this.#endpoints.set(key, response.repositoryEndpoint);
    return response.repositoryEndpoint;
  }

  #apiFor(region: string): CodeArtifactApi {
    const existing = this.#apis.get(region);
    if (existing !== undefined) return existing;
    const api = this.#apiFactory(region);
    this.#apis.set(region, api);
    return api;
  }
}

function createSdkApi(region: string): CodeArtifactApi {
  const client = new CodeartifactClient({ ...awsClientDefaults(), region });
  return {
    async getAuthorizationToken(args) {
      // No durationSeconds: the service default (12 h) is deliberate — the
      // cache above reuses across warm invocations via `expiration`.
      const response = await client.send(
        new GetAuthorizationTokenCommand({ domain: args.domain, domainOwner: args.domainOwner }),
      );
      if (response.authorizationToken === undefined || response.expiration === undefined) {
        throw new TargetCredentialsError(
          "resolve-failed",
          `CodeArtifact GetAuthorizationToken for domain '${args.domain}' returned no token/expiration`,
        );
      }
      return { authorizationToken: response.authorizationToken, expiration: response.expiration };
    },
    async getRepositoryEndpoint(args) {
      const response = await client.send(
        new GetRepositoryEndpointCommand({
          domain: args.domain,
          domainOwner: args.domainOwner,
          repository: args.repository,
          // The catalog schema passes the format through verbatim; the
          // service rejects unknown formats with a clear error, which is
          // the validation surface we want (no stale local enum).
          format: args.format as PackageFormat,
        }),
      );
      if (response.repositoryEndpoint === undefined) {
        throw new TargetCredentialsError(
          "resolve-failed",
          `CodeArtifact GetRepositoryEndpoint for '${args.domain}/${args.repository}' (${args.format}) returned no endpoint`,
        );
      }
      return { repositoryEndpoint: response.repositoryEndpoint };
    },
  };
}
