import type { AgentPayloadBase } from "../types/execution-override.js";
import type { RuntimeMessage } from "../types/runtime-message.js";
import type { Stage } from "../types/stage.js";

import type { SignedEnvelope } from "./verify.js";

/**
 * Map a verified envelope into the canonical `RuntimeMessage` shape per
 * `../../../../specs/agentic-development/agent-atc/specs/queue-api.md` §Envelope to RuntimeMessage mapping.
 *
 * Nested, not flattened: `payload: { envelope, request }`. The envelope's
 * domain fields move to `payload.envelope.*`; the envelope's inner payload
 * lands at `payload.request` unchanged.
 *
 * ATC always maps to `stage: "init"` regardless of envelope kind; future
 * envelope kinds (`cancel`, `summarize`, …) would map to different stages
 * via a kind-keyed table introduced at that point.
 */
export interface EnvelopeMappingOptions {
  /** SQS `MessageId` becomes `metadata.requestId` (the runtime idempotency key). */
  readonly sqsMessageId: string;
  /** When the message arrived at the input queue (ISO 8601). Defaults to now. */
  readonly receivedAt?: string;
  /** Per ADR-0012, ATC's only stage today is `init`. Override only if a future agent maps kinds elsewhere. */
  readonly stage?: Stage;
}

export interface AtcRuntimeMessagePayload extends AgentPayloadBase {
  readonly envelope: AtcEnvelopeFields;
  readonly request: Readonly<Record<string, unknown>>;
}

export interface AtcEnvelopeFields {
  readonly kind: string;
  readonly requestId: string;
  readonly consumer: string;
  readonly endUser: string;
  readonly conversationKey?: string;
  readonly timestamp: string;
  readonly replyTo?: string;
}

export function envelopeToRuntimeMessage(
  env: SignedEnvelope,
  options: EnvelopeMappingOptions,
): RuntimeMessage<AtcRuntimeMessagePayload> {
  const envelopeFields: AtcEnvelopeFields = {
    kind: env.kind,
    requestId: env.requestId,
    consumer: env.consumer,
    endUser: env.endUser,
    timestamp: env.timestamp,
    ...(env.conversationKey !== undefined ? { conversationKey: env.conversationKey } : {}),
    ...(env.replyTo !== undefined ? { replyTo: env.replyTo } : {}),
  };
  return {
    stage: options.stage ?? "init",
    payload: {
      envelope: envelopeFields,
      request: env.payload,
    },
    metadata: {
      receivedAt: options.receivedAt ?? new Date().toISOString(),
      sourceTrigger: "consumer",
      requestId: options.sqsMessageId,
    },
  };
}
