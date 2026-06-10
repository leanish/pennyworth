import { createHmac } from "node:crypto";

// `canonicalize` is the runtime's own envelope canonicaliser (main-entry
// export) — using it, plus the round-trip test against `verifyEnvelope`,
// is what guarantees signature compatibility.
import { canonicalize, type SignedEnvelope } from "@leanish/runtime";
import { parseShipItRequest, type ShipItRequest } from "@leanish/ship-it";

/** The consumerId this Lambda registers under in ship-it's ConsumerRegistry. */
export const NORMALIZER_CONSUMER_ID = "webhook-normalizer";
/** The only envelope kind this consumer is allowed to publish. */
export const SHIP_IT_EVENT_KIND = "ship-it-event";

export interface BuildSignedEnvelopeArgs {
  /** The normalized request; re-validated here before signing. */
  readonly request: ShipItRequest;
  /** The dedupe delivery id (GitHub delivery UUID / Jira event id or body hash). */
  readonly requestId: string;
  readonly endUser: string;
  /** Raw signing-key bytes (base64-decoded `ENVELOPE_SIGNING_KEY`). */
  readonly signingKey: Buffer;
  /** ISO 8601 override for tests; defaults to `new Date().toISOString()`. */
  readonly timestamp?: string;
}

/**
 * Build + sign a `ship-it-event` envelope.
 *
 * The payload is the request run BACK through ship-it's
 * `parseShipItRequest`: signing the validator's RETURNED value (not the
 * normalizer's own object) guarantees unknown fields can't leak into the
 * signed payload and pins the payload to the exact contract ship-it's
 * handler will re-validate on receive.
 *
 * Signature: HMAC-SHA256 hex over
 * `timestamp\nconsumer\nendUser\n<conversationKey-or-empty>\ncanonicalize(payload)`
 * — exactly the message `core/runtime/src/envelope/verify.ts` rebuilds.
 * v1 envelopes carry no conversationKey, so that segment is the empty
 * string.
 */
export function buildSignedEnvelope(args: BuildSignedEnvelopeArgs): SignedEnvelope {
  const payload = parseShipItRequest(args.request);
  const timestamp = args.timestamp ?? new Date().toISOString();
  const message =
    timestamp +
    "\n" +
    NORMALIZER_CONSUMER_ID +
    "\n" +
    args.endUser +
    "\n" +
    "" + // conversationKey-or-empty: always empty in v1.
    "\n" +
    canonicalize(payload);
  const signature = createHmac("sha256", args.signingKey).update(message).digest("hex");
  return {
    kind: SHIP_IT_EVENT_KIND,
    requestId: args.requestId,
    consumer: NORMALIZER_CONSUMER_ID,
    endUser: args.endUser,
    timestamp,
    payload: payload as unknown as Readonly<Record<string, unknown>>,
    signature,
  };
}
