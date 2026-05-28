import { createHmac, timingSafeEqual } from "node:crypto";

import { EnvelopeVerificationError } from "../errors.js";
import type { ConsumerRecord, ConsumerRegistry } from "../consumer-registry/store.js";

import { canonicalize } from "./canonical.js";

/**
 * Parsed + verified envelope shape. Agents never call the verifier
 * directly — the SQS adapter does, and feeds the resulting `RuntimeMessage`
 * down the dispatch path. Pulled out here so the mapping (envelope →
 * RuntimeMessage) lives near the verifier and is testable in isolation.
 *
 * See `../../../../specs/agentic-development/agent-atc/specs/queue-api.md` §Envelope.
 */
export interface SignedEnvelope {
  readonly kind: string;
  readonly requestId: string;
  readonly consumer: string;
  readonly endUser: string;
  readonly conversationKey?: string;
  readonly timestamp: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signature: string;
  readonly replyTo?: string;
}

export interface VerifyEnvelopeArgs {
  /** The raw envelope JSON, already `JSON.parse`d. */
  readonly envelope: unknown;
  readonly consumerRegistry: ConsumerRegistry;
  /** Override for testing; defaults to `Date.now()`. */
  readonly now?: number;
  /** Allowed clock skew vs `now`, in ms. Default 5 minutes (per queue-api.md). */
  readonly clockSkewMs?: number;
  /** Resolve a `ConsumerRecord` signing key into raw bytes. Required when records use `ssm-parameter`. */
  readonly resolveSigningKey?: (record: ConsumerRecord) => Promise<Buffer>;
}

const DEFAULT_SKEW_MS = 5 * 60 * 1000;

export async function verifyEnvelope(args: VerifyEnvelopeArgs): Promise<SignedEnvelope> {
  const env = parseEnvelopeShape(args.envelope, { requireSignature: true });
  checkTimestamp(env, args.now ?? Date.now(), args.clockSkewMs ?? DEFAULT_SKEW_MS);

  const record = await args.consumerRegistry.get(env.consumer);
  if (record === undefined) {
    throw new EnvelopeVerificationError(
      "unknown-consumer",
      `envelope.consumer='${env.consumer}' is not registered`,
    );
  }
  if (!record.allowedKinds.includes(env.kind)) {
    throw new EnvelopeVerificationError(
      "kind-not-allowed",
      `consumer '${env.consumer}' is not allowed to publish kind='${env.kind}' (allowed: [${record.allowedKinds.join(", ")}])`,
    );
  }

  const signingKey = await resolveKey(record, args.resolveSigningKey);
  const expected = computeSignature(env, signingKey);
  if (!compare(expected, env.signature)) {
    throw new EnvelopeVerificationError(
      "bad-signature",
      `envelope signature failed verification for consumer '${env.consumer}'`,
    );
  }
  return env;
}

/**
 * Parse + shape-validate an envelope, without HMAC / clock-skew / registry
 * checks. Shared by `verifyEnvelope` (which calls it with
 * `requireSignature: true`, then layers the cryptographic checks) and the
 * SQS shim's unsigned-consumer path (`requireSignature: false`, used for
 * local-dev / `signedEnvelope: false` triggers where the signature is
 * absent and trusted). Throws `EnvelopeVerificationError("malformed-envelope")`
 * on any shape failure.
 */
export function parseEnvelopeShape(
  value: unknown,
  options: { readonly requireSignature: boolean },
): SignedEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed("envelope must be an object");
  }
  const v = value as Record<string, unknown>;
  const requireString = (field: string): string => {
    const raw = v[field];
    if (typeof raw !== "string" || raw.length === 0) {
      throw malformed(`envelope.${field} must be a non-empty string`);
    }
    return raw;
  };
  const optionalString = (field: string): string | undefined => {
    const raw = v[field];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") {
      throw malformed(`envelope.${field} must be a string when present`);
    }
    return raw;
  };
  const kind = requireString("kind");
  const requestId = requireString("requestId");
  const consumer = requireString("consumer");
  const endUser = requireString("endUser");
  const timestamp = requireString("timestamp");
  const signature = options.requireSignature ? requireString("signature") : optionalString("signature") ?? "";
  const conversationKey = optionalString("conversationKey");
  const replyTo = optionalString("replyTo");

  const payload = v["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw malformed("envelope.payload must be an object");
  }
  return {
    kind,
    requestId,
    consumer,
    endUser,
    timestamp,
    signature,
    payload: payload as Readonly<Record<string, unknown>>,
    ...(conversationKey !== undefined ? { conversationKey } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
  };
}

function checkTimestamp(env: SignedEnvelope, now: number, skewMs: number): void {
  const t = Date.parse(env.timestamp);
  if (Number.isNaN(t)) {
    throw malformed(`envelope.timestamp '${env.timestamp}' is not a valid ISO 8601 timestamp`);
  }
  if (Math.abs(now - t) > skewMs) {
    throw new EnvelopeVerificationError(
      "timestamp-outside-skew",
      `envelope.timestamp '${env.timestamp}' is outside the allowed ${Math.floor(skewMs / 60_000)}-minute clock-skew window`,
    );
  }
}

async function resolveKey(
  record: ConsumerRecord,
  resolver: VerifyEnvelopeArgs["resolveSigningKey"],
): Promise<Buffer> {
  const sk = record.signingKey;
  if (sk.kind === "literal") {
    return Buffer.from(sk.base64, "base64");
  }
  if (resolver === undefined) {
    throw new EnvelopeVerificationError(
      "signing-key-unavailable",
      `consumer '${record.consumerId}' uses signingKey.kind='ssm-parameter' but no resolveSigningKey was supplied to verifyEnvelope`,
    );
  }
  return resolver(record);
}

function computeSignature(env: SignedEnvelope, key: Buffer): string {
  const canonicalPayload = canonicalize(env.payload);
  const message =
    env.timestamp +
    "\n" +
    env.consumer +
    "\n" +
    env.endUser +
    "\n" +
    (env.conversationKey ?? "") +
    "\n" +
    canonicalPayload;
  const hmac = createHmac("sha256", key);
  hmac.update(message);
  return hmac.digest("hex");
}

function compare(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(actualHex, "hex"));
  } catch {
    return false;
  }
}

function malformed(message: string): EnvelopeVerificationError {
  return new EnvelopeVerificationError("malformed-envelope", message);
}
