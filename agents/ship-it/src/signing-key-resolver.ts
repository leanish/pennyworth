import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

import { EnvelopeVerificationError } from "@leanish/runtime";
import type { ConsumerRecord } from "@leanish/runtime/lambda";

/**
 * Resolve a `ConsumerRecord`'s `signingKey` into raw HMAC-key bytes.
 * Mirrors ask-the-code's resolver (the suite's established pattern for
 * signed-envelope consumer triggers); if a third agent needs it, the
 * resolver should graduate into `@leanish/runtime`.
 *
 * Two supported variants:
 *
 *   - `signingKey.kind === "literal"`  → base64-decode the inlined bytes.
 *     Used by local-mode dev fixtures and the unit-test path. No AWS call.
 *
 *   - `signingKey.kind === "ssm-parameter"` → fetch the `SecureString`
 *     value from AWS SSM Parameter Store via `GetParameter({ Name,
 *     WithDecryption: true })`. Cached in-process by parameter name with a
 *     TTL window (default 10 minutes); concurrent fetches for the same
 *     parameter coalesce on the in-flight Promise.
 *
 * Errors map to `EnvelopeVerificationError("signing-key-unavailable", …)`
 * so the SQS shim records them as envelope rejections, not uncategorised
 * handler failures.
 */
export interface CreateSigningKeyResolverOptions {
  readonly ssmClient: SSMClient;
  /** TTL for cached secret values, in ms. Default: 10 minutes. */
  readonly cacheTtlMs?: number;
  /** Override for testing; defaults to `Date.now`. */
  readonly clock?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  readonly inFlight?: Promise<Buffer>;
  readonly value?: Buffer;
  readonly expiresAt?: number;
}

/**
 * Returns a `resolveSigningKey` function suitable for
 * `createSqsLambdaShim({ resolveSigningKey })`.
 */
export function createSigningKeyResolver(
  options: CreateSigningKeyResolverOptions,
): (record: ConsumerRecord) => Promise<Buffer> {
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.clock ?? Date.now;
  const client = options.ssmClient;
  const cache = new Map<string, CacheEntry>();

  return async function resolveSigningKey(record: ConsumerRecord): Promise<Buffer> {
    const key = record.signingKey;
    if (key.kind === "literal") {
      return Buffer.from(key.base64, "base64");
    }
    const name = key.name;

    const cached = cache.get(name);
    if (cached?.inFlight !== undefined) {
      return cached.inFlight;
    }
    if (
      cached?.value !== undefined &&
      cached.expiresAt !== undefined &&
      cached.expiresAt > now()
    ) {
      return cached.value;
    }

    const fetchPromise = fetchParameter(client, name, record.consumerId);
    cache.set(name, { inFlight: fetchPromise });
    try {
      const value = await fetchPromise;
      cache.set(name, { value, expiresAt: now() + ttl });
      return value;
    } catch (err) {
      // Clear the in-flight marker so a retry doesn't await a rejected
      // promise; never cache the failure itself (secrets may be rotated).
      cache.delete(name);
      throw err;
    }
  };
}

async function fetchParameter(
  client: SSMClient,
  name: string,
  consumerId: string,
): Promise<Buffer> {
  let response;
  try {
    response = await client.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
  } catch (err) {
    throw new EnvelopeVerificationError(
      "signing-key-unavailable",
      `failed to fetch signing key for consumer '${consumerId}' from SSM parameter '${name}': ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const value = response.Parameter?.Value;
  if (typeof value !== "string" || value.length === 0) {
    throw new EnvelopeVerificationError(
      "signing-key-unavailable",
      `SSM returned no Parameter.Value for consumer '${consumerId}' parameter '${name}' ` +
        `(expected a non-empty SecureString value)`,
    );
  }
  return Buffer.from(value, "utf8");
}
