import type { AgentPayloadBase } from "@leanish/runtime";

/**
 * Per-stage payload shapes for document-it. The discriminator is the
 * runtime's `stage` (init / breakdown), not a field inside the payload.
 */
export interface DocumentItInitPayload extends AgentPayloadBase {
  // Scheduler tick — no payload data needed. Empty so the field exists.
}

export interface DocumentItBreakdownPayload extends AgentPayloadBase {
  /** Catalog project id, e.g. "leanish/foo". */
  readonly projectId: string;
}

export type DocumentItPayload = DocumentItInitPayload | DocumentItBreakdownPayload;
