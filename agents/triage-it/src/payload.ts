import type { AgentPayloadBase } from "@leanish/runtime";

import type { TriageRequest } from "./request-schema.js";

/**
 * triage-it's `RuntimeMessage.payload` shape. Produced by the SQS adapter
 * from the consumer's signed envelope (`envelope/to-runtime-message.ts`
 * mapping: `payload = { envelope, request }`).
 *
 * `envelope` carries the consumer's wire-level domain fields; `request`
 * carries the triage body (ticket key, customer, evidence blob URI,
 * problem statement, optional code scope). The `TriageRequest` type is
 * owned by `request-schema.ts` — the same module that defines
 * `parseTriageRequest`, so type and validator can't drift.
 */
export interface TriagePayload extends AgentPayloadBase {
  readonly envelope: TriageEnvelope;
  readonly request: TriageRequest;
}

export interface TriageEnvelope {
  /** triage-it wire vocabulary, distinct from `RuntimeMessage.stage`. */
  readonly kind: "triage";
  readonly requestId: string;
  readonly consumer: string;
  /**
   * Required by the envelope spec and enforced by the runtime's envelope
   * verifier before the handler runs. The type reflects the
   * post-verification invariant: every `TriageEnvelope` that reaches the
   * handler has a non-empty `endUser`.
   */
  readonly endUser: string;
  readonly conversationKey?: string;
  readonly timestamp: string;
  /**
   * Optional. SQS queue ARN where triage-it delivers the terminal reply
   * in AWS mode. Local mode envelopes omit it; the handler returns the
   * reply directly via `run-local`'s Promise instead.
   */
  readonly replyTo?: string;
}
