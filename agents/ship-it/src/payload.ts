import type { AgentPayloadBase } from "@leanish/runtime";

import { ShipItValidationError, type ShipItRequest } from "./request-schema.js";

/**
 * ship-it's per-stage `RuntimeMessage.payload` shapes. Two wire paths:
 *
 *   - `init` — a signed consumer envelope (kind `ship-it-event`) from the
 *     webhook normalizer; the SQS adapter maps it to the nested
 *     `{ envelope, request }` layout.
 *   - `revisit` — a self-published runtime message (`runtime.publishDelayed`,
 *     ADR-0011); the payload is the flat `ShipItRevisitPayload` — NOT an
 *     envelope (no `{ envelope, request }` nesting).
 *
 * The discriminator is the runtime's `stage`, not a field inside the payload.
 */
export interface ShipItEnvelope {
  /** ship-it wire vocabulary, distinct from RuntimeMessage.stage. */
  readonly kind: "ship-it-event";
  readonly requestId: string;
  readonly consumer: string;
  readonly endUser: string;
  readonly conversationKey?: string;
  readonly timestamp: string;
  readonly replyTo?: string;
}

export interface ShipItInitPayload extends AgentPayloadBase {
  readonly envelope: ShipItEnvelope;
  readonly request: ShipItRequest;
}

export interface ShipItRevisitPayload extends AgentPayloadBase {
  /** Ticket key the draft PR implements, e.g. "ABC-123". */
  readonly ticketKey: string;
  /** catalogit project id, carried for log context and future use. */
  readonly projectId: string;
  /** Draft PR number opened by code-it. */
  readonly prNumber: number;
  /** PR head branch, e.g. "ship-it/ABC-123". */
  readonly branch: string;
  /** How many revisits have already run; bounded by the cycle budget (3). */
  readonly revisitCount: number;
}

export type ShipItPayload = ShipItInitPayload | ShipItRevisitPayload;

/**
 * Validate a revisit payload at the handler boundary. The SQS shim only
 * shape-checks `{ stage, payload }` for self messages; field-level
 * validation is the handler's job. Throws `ShipItValidationError`.
 */
export function parseShipItRevisitPayload(raw: unknown): ShipItRevisitPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ShipItValidationError("revisit payload must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const ticketKey = obj["ticketKey"];
  const projectId = obj["projectId"];
  const prNumber = obj["prNumber"];
  const branch = obj["branch"];
  const revisitCount = obj["revisitCount"];
  if (typeof ticketKey !== "string" || ticketKey.length === 0) {
    throw new ShipItValidationError("revisit payload.ticketKey must be a non-empty string");
  }
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new ShipItValidationError("revisit payload.projectId must be a non-empty string");
  }
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new ShipItValidationError("revisit payload.prNumber must be a positive integer");
  }
  if (typeof branch !== "string" || branch.length === 0) {
    throw new ShipItValidationError("revisit payload.branch must be a non-empty string");
  }
  if (
    typeof revisitCount !== "number" ||
    !Number.isInteger(revisitCount) ||
    revisitCount < 0
  ) {
    throw new ShipItValidationError(
      "revisit payload.revisitCount must be a non-negative integer",
    );
  }
  return { ticketKey, projectId, prNumber, branch, revisitCount };
}
