import {
  GetParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

import { EnvelopeVerificationError } from "@leanish/agent-runtime";
import type { ConsumerRecord } from "@leanish/agent-runtime/lambda";

/**
 * Resolve a `ConsumerRecord`'s `signingKey` into raw HMAC-key bytes.
 *
 * Two supported variants:
 *
 *   - `signingKey.kind === "literal"`  → base64-decode the inlined bytes.
 *     Used by local-mode dev fixtures and the unit-test path. No AWS call.
 *
 *   - `signingKey.kind === "ssm-parameter"` → fetch the `SecureString`
 *     value from AWS SSM Parameter Store via `GetParameter({ Name,
 *     WithDecryption: true })`. Cached in-process by parameter name with a
 *     TTL window (default 5 minutes) so we don't burn a `GetParameter` call
 *     on every inbound SQS message. Cache misses (after TTL) trigger a
 *     single re-fetch; repeated fetches inside the TTL coalesce on the
 *     in-flight Promise to avoid stampedes during cold-start surges.
 *
 * Errors are mapped to `EnvelopeVerificationError("signing-key-unavailable", …)`
 * so the SQS shim turns them into envelope-rejection outcomes (not
 * uncategorised handler failures). The wrapped SSM error is included in the
 * message for ops triage.
 *
 * Caveat: the TTL is local to one Lambda container — different cold-start
 * containers have independent caches. That's fine for HMAC keys, which are
 * stable; it would matter if we used this resolver for short-lived
 * credentials (which we don't).
 */
export interface CreateSigningKeyResolverOptions {
  /**
   * Override the SSM client. Production passes the
   * `awsClientDefaults()`-wired client constructed at cold start; tests
   * pass a mock or a LocalStack-pointed client.
   */
  readonly ssmClient: SSMClient;
  /**
   * TTL for cached secret values, in ms. Default: 5 minutes. Set lower
   * (e.g. 30s) if your operational model expects rapid rotation; set
   * higher with care (rotation lag = TTL + Lambda container lifetime).
   */
  readonly cacheTtlMs?: number;
  /**
   * Override for testing; defaults to `Date.now`.
   */
  readonly clock?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

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
      // Coalesce concurrent fetches on the same parameter — important on
      // cold start when several SQS records arrive in one batch keyed on
      // the same consumer.
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
      // promise. Don't cache the failure itself — operators may rotate
      // the secret + we want the next invocation to pick it up.
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
