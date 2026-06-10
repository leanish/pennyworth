import type { AgentPayloadBase } from "@leanish/runtime";

/**
 * Per-stage payload shapes for secureit. The discriminator is the runtime's
 * `stage` (init / breakdown / revisit), not a field inside the payload.
 *
 * See `overview.md` §Per-project fan-out pattern
 * and `secureit-revisit.md`.
 */
export interface SecureitInitPayload extends AgentPayloadBase {
  // Scheduler tick — no payload data needed. Empty so the field exists.
}

export interface SecureitBreakdownPayload extends AgentPayloadBase {
  /** catalogit project id, e.g. "leanish/foo". */
  readonly projectId: string;
}

export interface SecureitRevisitPayload extends AgentPayloadBase {
  /** catalogit project id. */
  readonly repo: string;
  /** PR branch name, e.g. "secureit/GHSA-xxxx-package". */
  readonly branch: string;
  /** Reference back to the alert this PR addresses. */
  readonly alertRef: string;
  /** Bounded by the revisit cap (default 2 — skill-internal constant for now). */
  readonly revisitCount: number;
}

export type SecureitPayload =
  | SecureitInitPayload
  | SecureitBreakdownPayload
  | SecureitRevisitPayload;
