import type { AgentPayloadBase } from "@leanish/agent-runtime";

import type { AtcRequest } from "./request-schema.js";

/**
 * ATC's `RuntimeMessage.payload` shape. Produced by the SQS adapter from
 * the consumer's signed envelope — see `../../../specs/agentic-development/agent-atc/specs/queue-api.md`
 * §Envelope to RuntimeMessage mapping.
 *
 * `envelope` carries the consumer's wire-level domain fields; `request`
 * carries the consumer-supplied ask body (question, transcript, project
 * scope, attachments, execution overrides, flags). The `AtcRequest` /
 * `AtcTranscriptTurn` / `AtcAttachment` types are owned by
 * `request-schema.ts` (single source of truth — same module that defines
 * `parseAtcRequest`, so type and validator can't drift).
 */
export interface AtcPayload extends AgentPayloadBase {
  readonly envelope: AtcEnvelope;
  readonly request: AtcRequest;
}

export interface AtcEnvelope {
  readonly kind: "ask"; // ATC wire vocabulary, distinct from RuntimeMessage.stage
  readonly requestId: string;
  readonly consumer: string;
  /**
   * Required by the envelope spec (`queue-api.md`) and enforced by the
   * runtime's envelope verifier (`envelope/verify.ts` rejects envelopes
   * without it as `malformed-envelope`). The type reflects the
   * post-verification invariant: every `AtcEnvelope` that reaches the
   * handler has a non-empty `endUser`.
   */
  readonly endUser: string;
  readonly conversationKey?: string;
  readonly timestamp: string;
  /**
   * Optional. SQS queue ARN where ATC delivers the terminal reply in AWS
   * mode (per `../../../specs/agentic-development/agent-atc/specs/queue-api.md`). Local mode envelopes omit it; the
   * handler returns the reply directly via `run-local`'s Promise instead.
   */
  readonly replyTo?: string;
}
