import type { Stage } from "./stage.js";
import type { SourceTrigger } from "./source-trigger.js";
import type { AgentPayloadBase } from "./execution-override.js";

/**
 * The on-the-wire shape of every message a runtime-driven handler receives.
 * See `agent-runtime/specs/overview.md` §RuntimeMessage shape.
 *
 * Agent-specific protocol fields live in `payload`, not in `metadata`.
 * `metadata` only carries trigger-source-agnostic fields the runtime needs.
 */
export interface RuntimeMessageMetadata {
  /** ISO 8601, when the message arrived at the input queue. */
  readonly receivedAt: string;
  /** Where the message came from. */
  readonly sourceTrigger: SourceTrigger;
  /** Idempotency key — always the SQS MessageId (or local-mode-minted shape; see ADR-0006). */
  readonly requestId: string;
}

export interface RuntimeMessage<P extends AgentPayloadBase = AgentPayloadBase> {
  readonly stage: Stage;
  readonly payload: P;
  readonly metadata: RuntimeMessageMetadata;
}
